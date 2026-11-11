/**
 * The Proxmox VE API client.
 *
 * The plugin talks to a node over ssh for the console and the guest agent, but
 * everything that is *configuration* belongs in the API: it is cluster-wide
 * (a VM can be found on any node), it is where the tokens with their limited
 * permissions live, and it does not need a shell on the host.
 *
 * Authentication is an API token (`PVEAPIToken=user@realm!tokenid=secret`),
 * which Proxmox accepts without a ticket and without CSRF.
 */
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

/** An error the agent can read: status, path and the message from Proxmox. */
export class PveApiError extends Error {
  constructor(message, { status = 0, method = '', path = '', body = '', code } = {}) {
    super(message);
    this.name = 'PveApiError';
    this.code = code ?? (status === 401 || status === 403 ? 'PVE_API_DENIED' : 'PVE_API_FAILED');
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

/** `AA:BB:…` → `aa:bb:…`, so a fingerprint typed in either case matches. */
function normalizeFingerprint(value) {
  return String(value ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

/** The certificate fingerprint Proxmox prints: sha256 over the DER bytes. */
function fingerprintOf(socket) {
  const certificate = socket.getPeerCertificate?.();
  if (!certificate || !certificate.raw) return '';
  return crypto.createHash('sha256').update(certificate.raw).digest('hex');
}

/**
 * A token string is either the full `user@realm!id=secret` or just the secret.
 * The settings card stores the full string, because that is what Proxmox shows
 * once and never again.
 */
function tokenHeader(token, username) {
  const value = String(token ?? '').trim();
  if (value.includes('!') && value.includes('=')) return value;
  if (value.includes('!') && username) return `${value}=`;
  if (username) return `${username}!=${value}`;
  // A bare secret is not a usable credential: Proxmox needs the identity and the
  // token id in the header, and it only shows the secret once. Failing here with
  // the expected shape beats a 401 that says nothing.
  throw new PveApiError(
    'the Proxmox API token must be written as `user@realm!tokenid=secret` ' +
      '(for example `root@pam!dsh=…`); a bare secret cannot authenticate',
    { code: 'PVE_API_CONFIGURATION' },
  );
}

export class PveApi {
  /**
   * @param {{baseUrl: string, token: string, username?: string, insecureTls?: boolean,
   *   fingerprint?: string, timeoutMs?: number}} options
   */
  constructor(options) {
    const url = new URL(String(options.baseUrl));
    this.url = url;
    this.token = tokenHeader(options.token, options.username);
    this.insecureTls = options.insecureTls === true;
    this.fingerprint = normalizeFingerprint(options.fingerprint);
    this.timeoutMs = Number(options.timeoutMs ?? 15_000);
    this.agent = new (url.protocol === 'https:' ? https : http).Agent({
      keepAlive: true,
      maxSockets: 4,
      rejectUnauthorized: this.fingerprint === '' ? !this.insecureTls : undefined,
    });
    /** vmid → node, filled by nodeForVmid and refreshed when a VM moves. */
    this.nodeCache = new Map();
  }

  /** A path under `/api2/json`; the settings card may carry the prefix already. */
  #requestPath(path) {
    const clean = String(path ?? '');
    const base = this.url.pathname.replace(/\/$/, '');
    const prefix = base.endsWith('/api2/json') ? '' : '/api2/json';
    return `${base}${prefix}${clean.startsWith('/') ? clean : `/${clean}`}`;
  }

  /**
   * One API call.
   * @param {'GET'|'POST'|'PUT'|'DELETE'} method
   * @param {string} path API path, for example `/nodes/pve1/qemu/100/status/current`.
   * @param {{params?: Record<string, string|number|boolean>, body?: object, signal?: AbortSignal, timeoutMs?: number}} [options]
   * @returns {Promise<unknown>} the `data` field of the answer.
   */
  async request(method, path, options = {}) {
    try {
      return await this.#send(method, path, options);
    } catch (error) {
      // A kept-alive socket can be closed by the node between two calls; the
      // request then fails before anything was read. Retrying once on a fresh
      // socket is safe for a GET and turns a spurious "socket hang up" into a
      // normal answer. Mutating verbs are not retried: the node may have applied
      // them before the connection broke.
      const transient = method === 'GET' && !options.signal?.aborted && /socket hang up|ECONNRESET|EPIPE/.test(String(error?.message ?? ''));
      if (!transient) throw error;
      this.#resetAgent();
      return await this.#send(method, path, options);
    }
  }

  /** Replace the keep-alive pool; used after a stale socket was detected. */
  #resetAgent() {
    try {
      this.agent.destroy();
    } catch {
      /* a destroyed pool is the state we want */
    }
    this.agent = new (this.url.protocol === 'https:' ? https : http).Agent({
      keepAlive: true,
      maxSockets: 4,
      rejectUnauthorized: this.fingerprint === '' ? !this.insecureTls : undefined,
    });
  }

  /** One attempt at a request, without the transient-error retry. */
  async #send(method, path, options = {}) {
    const target = new URL(this.#requestPath(path), `${this.url.protocol}//${this.url.host}`);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      target.searchParams.set(key, String(value));
    }
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers = {
      accept: 'application/json',
      authorization: `PVEAPIToken=${this.token}`,
    };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const timeoutMs = Number(options.timeoutMs ?? this.timeoutMs);
    const loader = target.protocol === 'https:' ? https : http;
    return await new Promise((resolve, reject) => {
      const request = loader.request(
        target,
        { method, headers, agent: this.agent, timeout: timeoutMs, signal: options.signal },
        (response) => this.#settle(method, path, response, resolve, reject),
      );
      request.on('timeout', () => {
        request.destroy(new PveApiError(`${method} ${path} timed out after ${timeoutMs} ms`, { method, path }));
      });
      request.on('error', (error) => {
        reject(error instanceof PveApiError ? error : new PveApiError(`${method} ${path} → ${error.message}`, { method, path }));
      });
      if (payload !== undefined) request.write(payload);
      request.end();
    });
  }

  /**
   * Read one API answer: check the pinned certificate, unwrap `data`, turn an
   * error body into a message the agent can act on. Shared by `request` and
   * `upload`, so both transports report failures the same way.
   */
  #settle(method, path, response, resolve, reject) {
    if (this.fingerprint !== '') {
      const actual = fingerprintOf(response.socket);
      if (actual !== this.fingerprint) {
        response.destroy();
        reject(
          new PveApiError(
            `the node certificate does not match the configured fingerprint (sha256 ${actual || 'unavailable'})`,
            { status: 0, method, path },
          ),
        );
        return;
      }
    }
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        let message = '';
        try {
          const parsed = JSON.parse(text);
          const errors = parsed?.errors;
          message = errors ? Object.entries(errors).map(([key, value]) => `${key}: ${value}`).join('; ') : (parsed?.message ?? '');
        } catch {
          /* the plain text is the message */
        }
        if (status === 401 || status === 403) {
          // Proxmox answers a denied call with no message at all, which reads like
          // a bug; name the likely cause instead of printing an empty body.
          if (message === '') {
            message = "permission denied — the token's role does not grant this path (Permissions.Modify manages access; VM.* and Datastore.* cover guests and storage)";
          }
        } else if (message === '') {
          message = text.length > 0 && text.length <= 300 ? text : '';
        }
        reject(new PveApiError(`${method} ${path} → HTTP ${status}: ${message}`, { status, method, path, body: text.slice(0, 1000) }));
        return;
      }
      try {
        const parsed = JSON.parse(text);
        resolve(parsed?.data ?? parsed);
      } catch (error) {
        reject(new PveApiError(`${method} ${path} → unreadable answer: ${error.message}`, { status, method, path, body: text.slice(0, 500) }));
      }
    });
  }

  /**
   * Upload one file to a storage (`POST /nodes/{node}/storage/{storage}/upload`).
   * The body is streamed as multipart/form-data: an ISO is hundreds of megabytes
   * and reading it into memory just to hand it to `http.request` would be a
   * pointless copy. The file path is on the machine that runs this plugin.
   * @param {string} path API path of the upload endpoint.
   * @param {{fields?: Record<string, string|number>, filePath: string, fileName?: string,
   *   contentType?: string, signal?: AbortSignal, timeoutMs?: number}} options
   * @returns {Promise<unknown>} the task id Proxmox answers with.
   */
  async upload(path, options = {}) {
    const { fields = {}, filePath, contentType = 'application/octet-stream', signal } = options;
    if (!filePath) throw new PveApiError('upload needs a file path', { method: 'POST', path });
    const fileName = String(options.fileName ?? filePath.split('/').pop() ?? 'upload.iso').replace(/["\r\n]/g, '');
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) throw new PveApiError(`${filePath} is not a file`, { method: 'POST', path });
    const boundary = `----dshpve${crypto.randomBytes(12).toString('hex')}`;
    const head = Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)
      .join('');
    const fileHead = `--${boundary}\r\nContent-Disposition: form-data; name="filename"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const contentLength = Buffer.byteLength(head) + Buffer.byteLength(fileHead) + stats.size + Buffer.byteLength(tail);
    const target = new URL(this.#requestPath(path), `${this.url.protocol}//${this.url.host}`);
    const loader = target.protocol === 'https:' ? https : http;
    const timeoutMs = Number(options.timeoutMs ?? this.timeoutMs);
    return await new Promise((resolve, reject) => {
      const request = loader.request(
        target,
        {
          method: 'POST',
          agent: this.agent,
          timeout: timeoutMs,
          signal,
          headers: {
            accept: 'application/json',
            authorization: `PVEAPIToken=${this.token}`,
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': contentLength,
          },
        },
        (response) => this.#settle('POST', path, response, resolve, reject),
      );
      request.on('timeout', () => {
        request.destroy(new PveApiError(`POST ${path} timed out after ${timeoutMs} ms`, { method: 'POST', path }));
      });
      request.on('error', (error) => {
        reject(error instanceof PveApiError ? error : new PveApiError(`POST ${path} → ${error.message}`, { method: 'POST', path }));
      });
      request.write(head);
      request.write(fileHead);
      const stream = fs.createReadStream(filePath);
      stream.on('error', (error) => request.destroy(error));
      stream.on('end', () => request.end(tail));
      stream.pipe(request, { end: false });
    });
  }

  get(path, options) {
    return this.request('GET', path, options);
  }

  post(path, body, options = {}) {
    return this.request('POST', path, { ...options, body });
  }

  put(path, body, options = {}) {
    return this.request('PUT', path, { ...options, body });
  }

  delete(path, options) {
    return this.request('DELETE', path, options);
  }

  /** `{version, release, repoid}` — also the cheapest permission probe. */
  async version() {
    return await this.get('/version');
  }

  /** Cluster resources; `type: 'vm'` is how a vmid finds its node. */
  async resources(type) {
    return await this.get('/cluster/resources', { params: type ? { type } : undefined });
  }

  async nodes() {
    return await this.get('/nodes');
  }

  /**
   * The node that currently owns a vmid. Cached for a minute because a running
   * migration is the only thing that moves a VM, and a stale answer fails loudly
   * ("configuration file does not exist") rather than silently.
   */
  async nodeForVmid(vmid, { signal, fresh = false } = {}) {
    const id = Number(vmid);
    const cached = this.nodeCache.get(id);
    if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.node;
    const list = await this.resources('vm', { signal });
    const entry = (Array.isArray(list) ? list : []).find((item) => Number(item.vmid) === id);
    if (!entry?.node) {
      throw new PveApiError(`VM ${id} was not found in /cluster/resources — check the id and the token permissions`, {
        method: 'GET',
        path: '/cluster/resources',
      });
    }
    this.nodeCache.set(id, { node: entry.node, at: Date.now() });
    return entry.node;
  }

  /** Forget a cached placement (after a migrate, or when a 404 says it moved). */
  forgetVmid(vmid) {
    this.nodeCache.delete(Number(vmid));
  }

  close() {
    this.agent.destroy();
  }
}
