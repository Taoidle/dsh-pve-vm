/**
 * Commit-confirm: a change that can cut the channel it travels over.
 *
 * A network reload or a firewall restart can make the node unreachable over the
 * very API and ssh session that requested it. The countermeasure is the one
 * network vendors use: before the change, copy the configuration files aside and
 * arm a detached timer that puts them back and reloads. If the change works the
 * timer is cancelled; if it locks us out, the timer fires and the node comes
 * back on its own — no monitor and keyboard required.
 *
 * Everything here runs through the ssh channel on purpose: arming a `systemd-run`
 * timer is not something the Proxmox API can do, so an instance configured for
 * the API alone cannot make these changes safely and the tools refuse them.
 */
import { randomBytes } from 'node:crypto';
import { shellQuote } from './ssh.js';
import { VmError } from './session.js';

/** Where the copies live on the node. */
const BACKUP_ROOT = '/var/lib/dsh-pve-vm/rollback';

/** A systemd unit name we minted ourselves (`dsh-rollback-1a2b3c4d5e`). */
const UNIT = /^[a-z][a-z0-9-]{0,40}-[0-9a-f]{8,16}$/;

/** An absolute file path without shell metacharacters. */
const FILE = /^\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

/**
 * Mint a unique id for one rollback/apply timer.
 * @param {'dsh-rollback'|'dsh-apply'} [prefix] the unit prefix.
 * @returns {string} a unit name that matches {@link UNIT}.
 */
export function rollbackId(prefix = 'dsh-rollback') {
  return `${prefix}-${randomBytes(5).toString('hex')}`;
}

/** Validate the config files a rollback protects. */
function assertFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new VmError('a rollback needs at least one configuration file', 'BAD_ARGUMENT');
  }
  return files.map((file) => {
    const text = String(file ?? '');
    if (!FILE.test(text)) throw new VmError(`invalid configuration path "${file}"`, 'BAD_ARGUMENT');
    return text;
  });
}

/** The name a file gets inside the backup directory. */
function copyName(file) {
  return file.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Put a copy of `files` aside and arm a timer that restores them.
 *
 * The timer runs `/bin/sh -c '<restore>'` once, `seconds` from now, detached from
 * this ssh session, so a reload that drops the session does not disarm it.
 *
 * @param {object} controller the instance controller (only `shell` is used).
 * @param {{id: string, files: string[], restoreCommand: string, seconds?: number, signal?: AbortSignal}} spec
 * @returns {Promise<{unit: string, seconds: number, backupDir: string, files: string[], restoreCommand: string}>}
 */
export async function armRollback(controller, { id, files, restoreCommand, seconds = 180, signal } = {}) {
  const unit = String(id ?? '');
  if (!UNIT.test(unit)) throw new VmError(`invalid rollback unit "${id}"`, 'BAD_ARGUMENT');
  const list = assertFiles(files);
  const delay = Math.trunc(Number(seconds));
  if (!Number.isFinite(delay) || delay < 30 || delay > 900) {
    throw new VmError('the rollback delay must be between 30 and 900 seconds', 'BAD_ARGUMENT');
  }
  if (typeof controller?.shell !== 'function') {
    throw new VmError(
      'this instance has no ssh channel, so the rollback timer cannot be armed — network and firewall changes need an instance with ssh access',
      'SSH_FAILED',
    );
  }
  if (typeof restoreCommand !== 'string' || restoreCommand.trim() === '') {
    throw new VmError('the rollback needs a reload command', 'BAD_ARGUMENT');
  }
  const dir = `${BACKUP_ROOT}/${unit}`;

  const backup = [`set -eu`, `mkdir -p ${shellQuote(dir)}`];
  for (const file of list) {
    backup.push(`if [ -e ${shellQuote(file)} ]; then cp -a ${shellQuote(file)} ${shellQuote(`${dir}/${copyName(file)}`)}; fi`);
  }
  const saved = await controller.shell(backup.join('\n'), { timeoutMs: 30_000, signal });
  if (saved.exitCode !== 0) {
    throw new VmError(`cannot save the rollback copy: ${saved.stderr || saved.stdout || 'no output'}`, 'NODE_COMMAND_FAILED');
  }

  const restore = [];
  for (const file of list) {
    const copy = `${dir}/${copyName(file)}`;
    // No copy means the file did not exist before the change: put it back that way.
    restore.push(`if [ -e ${shellQuote(copy)} ]; then cp -a ${shellQuote(copy)} ${shellQuote(file)}; else rm -f ${shellQuote(file)}; fi`);
  }
  restore.push(restoreCommand);
  const armed = await controller.shell(
    `systemd-run --unit=${unit} --on-active=${delay}s --collect --quiet --description=${shellQuote(`dsh-pve-vm rollback ${unit}`)} /bin/sh -c ${shellQuote(restore.join('\n'))}`,
    { timeoutMs: 30_000, signal },
  );
  if (armed.exitCode !== 0) {
    throw new VmError(`cannot arm the rollback timer: ${armed.stderr || armed.stdout || 'no output'}`, 'NODE_COMMAND_FAILED');
  }
  return { unit, seconds: delay, backupDir: dir, files: list, restoreCommand };
}

/**
 * Cancel an armed rollback and drop its copies.
 * @param {object} controller the instance controller.
 * @param {string} unit the unit name {@link armRollback} returned.
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{unit: string, cancelled: boolean}>}
 */
export async function cancelRollback(controller, unit, { signal } = {}) {
  const name = String(unit ?? '');
  if (!UNIT.test(name)) throw new VmError(`invalid rollback unit "${unit}"`, 'BAD_ARGUMENT');
  const dir = `${BACKUP_ROOT}/${name}`;
  const result = await controller.shell(
    `systemctl stop ${shellQuote(`${name}.timer`)} ${shellQuote(`${name}.service`)} >/dev/null 2>&1 || true; ` +
      `systemctl reset-failed ${shellQuote(`${name}.timer`)} ${shellQuote(`${name}.service`)} >/dev/null 2>&1 || true; ` +
      `rm -rf ${shellQuote(dir)}; echo cancelled`,
    { timeoutMs: 30_000, signal },
  );
  return { unit: name, cancelled: result.exitCode === 0 };
}

/**
 * Run a script detached from this ssh session, so the call returns even when the
 * script cuts the network it runs on.
 * @param {object} controller the instance controller.
 * @param {{id: string, script: string, description?: string, timeoutMs?: number, signal?: AbortSignal}} spec
 * @returns {Promise<{unit: string}>}
 */
export async function runDetached(controller, { id, script, description = 'dsh-pve-vm', timeoutMs = 30_000, signal } = {}) {
  const unit = String(id ?? '');
  if (!UNIT.test(unit)) throw new VmError(`invalid unit "${id}"`, 'BAD_ARGUMENT');
  if (typeof script !== 'string' || script.trim() === '') {
    throw new VmError('the detached script is empty', 'BAD_ARGUMENT');
  }
  const result = await controller.shell(
    `systemd-run --unit=${unit} --collect --quiet --description=${shellQuote(description)} /bin/sh -c ${shellQuote(script)}`,
    { timeoutMs, signal },
  );
  if (result.exitCode !== 0) {
    throw new VmError(`cannot start ${unit}: ${result.stderr || result.stdout || 'no output'}`, 'NODE_COMMAND_FAILED');
  }
  return { unit };
}

/** Wait, honouring an abort signal. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new VmError('aborted', 'TIMEOUT'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Check that the node still answers over the API.
 *
 * This is the "confirm" half of commit-confirm: while it runs, the rollback timer
 * is still armed, so a failing probe needs no action — the timer fires by itself.
 *
 * @param {object} controller the instance controller (API transport).
 * @param {{attempts?: number, delayMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{reachable: boolean, attempts: number, ms: number}>}
 */
export async function probeApi(controller, { attempts = 8, delayMs = 1500, signal } = {}) {
  const started = Date.now();
  const rounds = Math.max(1, Math.trunc(Number(attempts) || 1));
  for (let round = 1; round <= rounds; round += 1) {
    try {
      await controller.pveshGet('/version', {}, { signal });
      return { reachable: true, attempts: round, ms: Date.now() - started };
    } catch (error) {
      if (round < rounds) await sleep(delayMs, signal);
    }
  }
  return { reachable: false, attempts: rounds, ms: Date.now() - started };
}

/**
 * True when the instance can probe the node and arm a rollback: an API token for
 * the probe, an ssh channel for the timer. Without both, a change that locks the
 * node out could not be undone, so the tools refuse.
 * @param {{api?: {url?: string, token?: string}}} settings the pinned settings.
 * @returns {boolean} whether commit-confirm is possible.
 */
export function canCommitConfirm(settings) {
  return Boolean(settings?.api?.url && settings?.api?.token);
}
