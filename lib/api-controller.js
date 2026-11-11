/**
 * An API-backed controller.
 *
 * The plugin used to drive a node with `ssh qm …`; that works, but it pins every
 * tool to the node you can reach and needs a shell. This controller keeps the
 * same surface the tools already call (`pveshGet`, `pvesh`, `qm`, `qmOk`,
 * `command`) and answers it over the Proxmox API, so:
 *
 *   - a VM is found where it actually runs (`/cluster/resources`), not on the
 *     node the instance happens to point at;
 *   - the credential is a revocable API token instead of a root ssh key;
 *   - `qm` verbs map onto the REST endpoints the web UI itself uses.
 *
 * The console and the guest agent still go through ssh: they are a byte stream,
 * and the ssh transport already carries it without opening a second VNC session.
 * Their methods are delegated to the inner {@link VmController}, so the tools did
 * not have to change.
 */
import { VmController, VmError } from './session.js';
import { PveApi, PveApiError } from './api.js';

/** pvesh verbs → HTTP verbs. */
const VERBS = { get: 'GET', create: 'POST', set: 'PUT', delete: 'DELETE' };

/** Split `['--memory', '2048', '--purge']` into flags and positionals. */
function parseArgs(args) {
  const positional = [];
  const flags = new Map();
  const list = (Array.isArray(args) ? args : []).map((value) => String(value));
  for (let index = 0; index < list.length; index += 1) {
    const value = list[index];
    if (value.startsWith('--')) {
      const key = value.slice(2);
      const next = list[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        index += 1;
      } else {
        flags.set(key, '1');
      }
    } else {
      positional.push(value);
    }
  }
  return { positional, flags };
}

/** Turn API errors into the same VmError codes the ssh transport raises. */
function asVmError(error, context) {
  if (error instanceof VmError) return error;
  if (error instanceof PveApiError) {
    const code = error.code === 'PVE_API_DENIED'
      ? 'API_DENIED'
      : error.code === 'PVE_API_CONFIGURATION'
        ? 'BAD_ARGUMENT'
        : 'NODE_COMMAND_FAILED';
    return new VmError(`${context}: ${error.message}`, code);
  }
  return new VmError(`${context}: ${error?.message ?? error}`, 'NODE_COMMAND_FAILED');
}

export class ApiController {
  /**
   * @param {{settings: () => object, spawn: (spec: object) => object, cwd: string, log?: object}} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.ssh = new VmController(deps);
    this.api = null;
    this.nodeCache = null;
  }

  /** The instance settings this controller is pinned to. */
  get settings() {
    return this.deps.settings();
  }

  /** The configured API client, built on first use. */
  #client() {
    if (this.api !== null) return this.api;
    const settings = this.settings;
    const api = settings.api ?? {};
    if (!api.url) {
      throw new VmError(
        `instance "${settings.instance ?? '?'}" has no apiUrl — add it in the plugin settings, or switch the instance to mode "ssh"`,
        'BAD_INSTANCE',
      );
    }
    this.api = new PveApi({
      baseUrl: api.url,
      token: api.token ?? '',
      insecureTls: api.insecureTls === true,
      fingerprint: api.fingerprint ?? '',
      timeoutMs: Math.max(5_000, Number(settings.consoleTimeoutMs ?? 15_000)),
    });
    return this.api;
  }

  /** The allow-list check is shared with the ssh transport: one list, one rule. */
  assertAllowed(vmid) {
    return this.ssh.assertAllowed(vmid);
  }

  /**
   * The node the instance points at (its `node` field), used for node-level
   * operations. VM-level operations resolve the node from the vmid instead.
   */
  async nodeName() {
    const configured = String(this.settings.node ?? '').trim();
    if (configured) return configured;
    if (this.nodeCache) return this.nodeCache;
    const nodes = await this.#client().nodes();
    const online = (Array.isArray(nodes) ? nodes : []).filter((node) => node.status === 'online');
    const chosen = (online[0] ?? (Array.isArray(nodes) ? nodes[0] : null))?.node;
    if (!chosen) throw new VmError('the API answered with no nodes — check the token permissions', 'API_DENIED');
    this.nodeCache = chosen;
    return chosen;
  }

  /** The node that owns the vmid right now. */
  async nodeFor(vmid, options = {}) {
    return await this.#client().nodeForVmid(vmid, options);
  }

  /** GET a path (the same paths the tools already build for `pvesh`). */
  async pveshGet(path, params = {}, options = {}) {
    try {
      return await this.#client().get(path, { params, signal: options.signal, timeoutMs: options.timeoutMs });
    } catch (error) {
      throw asVmError(error, `GET ${path}`);
    }
  }

  /**
   * `pvesh` with the same answer shape the tool code already expects
   * (`exitCode`, `stdout`, `json`) — the REST answer becomes `stdout`, so a UPID
   * keeps flowing through the same code path.
   */
  /** Upload a local file to a storage; the API answers with a task id. */
  async upload(path, options = {}) {
    try {
      return await this.#client().upload(path, options);
    } catch (error) {
      throw asVmError(error, `POST ${path}`);
    }
  }

  /** Await a node task by UPID (uploads and storage deletes answer with one). */
  async waitTask(node, upid, options = {}) {
    return await this.#waitTask(node, upid, options);
  }

  async pvesh(method, path, options = {}) {
    const verb = VERBS[String(method).toLowerCase()];
    if (verb === undefined) throw new VmError(`unsupported pvesh method "${method}"`, 'BAD_ARGUMENT');
    const params = options.params ?? {};
    try {
      const data =
        verb === 'GET'
          ? await this.#client().get(path, { params, signal: options.signal, timeoutMs: options.timeoutMs })
          : verb === 'DELETE'
            ? await this.#client().delete(path, { params, signal: options.signal, timeoutMs: options.timeoutMs })
            : verb === 'POST'
              ? await this.#client().post(path, params, { signal: options.signal, timeoutMs: options.timeoutMs })
              : await this.#client().put(path, params, { signal: options.signal, timeoutMs: options.timeoutMs });
      return { exitCode: 0, stdout: typeof data === 'string' ? data : JSON.stringify(data ?? ''), stderr: '', json: data };
    } catch (error) {
      throw asVmError(error, `${verb} ${path}`);
    }
  }

  /** Wait for an asynchronous task the API returned. */
  async #waitTask(node, upid, { signal, timeoutMs = 120_000 } = {}) {
    if (typeof upid !== 'string' || !upid.startsWith('UPID:')) return upid;
    const deadline = Date.now() + timeoutMs;
    const path = `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`;
    for (;;) {
      if (Date.now() > deadline) throw new VmError(`task ${upid} did not finish within ${timeoutMs} ms`, 'NODE_COMMAND_FAILED');
      const status = await this.#client().get(path, { signal });
      if (status?.status === 'stopped') {
        const exit = String(status.exitstatus ?? '');
        if (exit !== '' && !exit.startsWith('OK')) {
          throw new VmError(`task ${upid} ended with "${exit}"`, 'NODE_COMMAND_FAILED');
        }
        return upid;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  /** Send a `qm`-style argument list to the API path that implements it. */
  async qm(args, options = {}) {
    const { positional, flags } = parseArgs(args);
    const verb = positional[0];
    if (!verb) throw new VmError('qm needs at least one argument', 'BAD_ARGUMENT');
    const client = this.#client();
    const signal = options.signal;
    const timeoutMs = options.timeoutMs ?? 120_000;

    // Runtime state is read by the console/agent path too, so status stays cheap.
    if (verb === 'status') {
      const node = await this.nodeFor(positional[1], { signal });
      const state = await client.get(`/nodes/${node}/qemu/${positional[1]}/status/current`, { signal });
      return { exitCode: 0, stdout: `status: ${state?.status ?? 'unknown'}`, stderr: '' };
    }

    const POWER = new Set(['start', 'stop', 'shutdown', 'reboot', 'reset', 'suspend', 'resume']);
    if (POWER.has(verb)) {
      const node = await this.nodeFor(positional[1], { signal });
      const body = verb === 'shutdown' && flags.has('timeout') ? { timeout: Number(flags.get('timeout')) } : {};
      const upid = await client.post(`/nodes/${node}/qemu/${positional[1]}/status/${verb}`, body, { signal });
      await this.#waitTask(node, upid, { signal, timeoutMs });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (verb === 'create') {
      const node = await this.nodeName();
      const body = { vmid: Number(positional[1]) };
      for (const [key, value] of flags) body[key] = value;
      const upid = await client.post(`/nodes/${node}/qemu`, body, { signal, timeoutMs });
      await this.#waitTask(node, upid, { signal, timeoutMs: 300_000 });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (verb === 'destroy') {
      const node = await this.nodeFor(positional[1], { signal });
      const upid = await client.delete(`/nodes/${node}/qemu/${positional[1]}`, {
        params: flags.has('purge') ? { purge: 1 } : undefined,
        signal,
        timeoutMs,
      });
      await this.#waitTask(node, upid, { signal, timeoutMs });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (verb === 'snapshot' || verb === 'delsnapshot' || verb === 'rollback') {
      const node = await this.nodeFor(positional[1], { signal });
      const base = `/nodes/${node}/qemu/${positional[1]}/snapshot`;
      const name = positional[2];
      let upid;
      if (verb === 'snapshot') {
        upid = await client.post(base, { snapname: name, description: flags.get('description') ?? '' }, { signal, timeoutMs });
      } else if (verb === 'delsnapshot') {
        upid = await client.delete(`${base}/${encodeURIComponent(name)}`, { signal, timeoutMs });
      } else {
        upid = await client.post(`${base}/${encodeURIComponent(name)}/rollback`, {}, { signal, timeoutMs });
      }
      await this.#waitTask(node, upid, { signal, timeoutMs });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (verb === 'set') {
      const node = await this.nodeFor(positional[1], { signal });
      const body = {};
      for (const [key, value] of flags) {
        if (key === 'delete') body.delete = value;
        else body[key] = value;
      }
      await client.put(`/nodes/${node}/qemu/${positional[1]}/config`, body, { signal, timeoutMs });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (verb === 'rescan') {
      const vmid = positional[1] ?? flags.get('vmid');
      const node = await this.nodeFor(vmid, { signal });
      const upid = await client.post(`/nodes/${node}/qemu/${vmid}/rescan`, {}, { signal, timeoutMs });
      await this.#waitTask(node, upid, { signal, timeoutMs });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    // `qm trim` has no REST endpoint on PVE 7/8; the ssh path still has it.
    if (verb === 'trim') return await this.ssh.qm(args, options);

    if (verb === 'resize') {
      const node = await this.nodeFor(positional[1], { signal });
      const upid = await client.post(`/nodes/${node}/qemu/${positional[1]}/resize`, { disk: positional[2], size: positional[3] }, { signal, timeoutMs });
      await this.#waitTask(node, upid, { signal, timeoutMs });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (verb === 'move-disk') {
      const node = await this.nodeFor(positional[1], { signal });
      const body = { disk: positional[2], storage: positional[3] };
      if (flags.has('delete')) body.delete = 1;
      const upid = await client.post(`/nodes/${node}/qemu/${positional[1]}/move_disk`, body, { signal, timeoutMs });
      await this.#waitTask(node, upid, { signal, timeoutMs });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (verb === 'clone') {
      const node = await this.nodeFor(positional[1], { signal });
      const body = { newid: Number(positional[2]) };
      for (const [key, value] of flags) body[key] = value;
      const upid = await client.post(`/nodes/${node}/qemu/${positional[1]}/clone`, body, { signal, timeoutMs });
      await this.#waitTask(node, upid, { signal, timeoutMs });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (verb === 'migrate') {
      const node = await this.nodeFor(positional[1], { signal });
      const body = { target: positional[2] };
      for (const [key, value] of flags) body[key === 'with-local-disks' ? 'with-local-disks' : key] = value;
      const upid = await client.post(`/nodes/${node}/qemu/${positional[1]}/migrate`, body, { signal, timeoutMs });
      await this.#waitTask(node, upid, { signal, timeoutMs: 3_600_000 });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    // Anything not mapped keeps working through ssh.
    return await this.ssh.qm(args, options);
  }

  /** `qm` with the exit code turned into an error, like the ssh transport. */
  async qmOk(args, options = {}) {
    try {
      return await this.qm(args, options);
    } catch (error) {
      throw asVmError(error, `qm ${Array.isArray(args) ? args[0] : ''}`);
    }
  }

  /**
   * Run a shell script on the node over the ssh channel. The API has no such
   * endpoint, and the callers are the commit-confirm helpers: a rollback timer is
   * a `systemd-run` unit, not a REST resource.
   * @param {string} script the script body.
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
   */
  async shell(script, options = {}) {
    return await this.ssh.shell(script, options);
  }

  /**
   * A raw command (`qmrestore` is the only one). The API equivalent is a POST of
   * the archive onto the VM endpoint.
   */
  async command(program, args, options = {}) {
    if (program !== 'qmrestore') return await this.ssh.command(program, args, options);
    const { positional, flags } = parseArgs(args);
    const [archive, vmid] = positional;
    const node = await this.nodeName();
    try {
      const upid = await this.#client().post(
        `/nodes/${node}/qemu`,
        { vmid: Number(vmid), archive, ...(flags.has('force') ? { force: 1 } : {}) },
        { signal: options.signal, timeoutMs: options.timeoutMs ?? 1_800_000 },
      );
      await this.#waitTask(node, upid, { signal: options.signal, timeoutMs: 3_600_000 });
      return { exitCode: 0, stdout: String(upid ?? ''), stderr: '' };
    } catch (error) {
      throw asVmError(error, 'qmrestore');
    }
  }

  closeAll() {
    this.ssh.closeAll();
    this.api?.close();
    this.api = null;
  }
}

/**
 * Wrap a controller so the console/guest methods the ssh transport owns
 * (`withConsole`, `guestExec`, `status`, …) keep working untouched.
 * @param {ApiController} controller
 */
export function withSshFallback(controller) {
  return new Proxy(controller, {
    // Every method is bound to the real controller: the class reads private
    // fields, and a private read through the proxy's receiver throws
    // "Receiver must be an instance of class ApiController".
    get(target, property) {
      if (property in target) {
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const value = target.ssh[property];
      return typeof value === 'function' ? value.bind(target.ssh) : value;
    },
  });
}
