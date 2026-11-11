/**
 * Second confirmation for destructive operations.
 *
 * Why a token and not a boolean. A boolean `confirm: true` is a single word the
 * model can emit in the same breath as the command, so it protects nothing: the
 * dangerous call and its "confirmation" are one decision. A token forces two
 * separate calls — the first one performs nothing and returns a human-readable
 * summary plus a short-lived token, the second one carries the token back. That
 * is exactly one extra round trip through the agent, and the token is bound to
 * the action and the target, so it cannot be reused for something else.
 *
 * Tokens live in memory (a plugin restart drops them), expire after three
 * minutes and are single-use: a replayed token fails, which also makes an agent
 * retry loop visible instead of silently repeating a destructive command.
 */
import { randomBytes } from 'node:crypto';
import { VmError } from './session.js';

/** How long a token stays valid, ms. */
const DEFAULT_TTL_MS = 3 * 60 * 1000;

/** How many outstanding tokens to keep before the oldest are dropped. */
const DEFAULT_LIMIT = 32;

/**
 * Outstanding confirmation requests.
 */
export class ConfirmationStore {
  /**
   * @param {{ttlMs?: number, limit?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.now = options.now ?? Date.now;
    /** @type {Map<string, object>} */
    this.records = new Map();
  }

  /**
   * Issue a token for one action on one target.
   * @param {{instance: string, action: string, target: string, risk?: string, summary: string}} request
   * @returns {object} the record, including the token.
   */
  issue(request) {
    const createdAt = this.now();
    const record = {
      token: randomBytes(9).toString('base64url'),
      instance: request.instance,
      action: request.action,
      target: String(request.target ?? ''),
      risk: request.risk ?? 'danger',
      summary: request.summary,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.records.set(record.token, record);
    this.#trim();
    return record;
  }

  /**
   * Consume a token. Undefined when it is unknown, expired or already used.
   * @param {string} token the token from the second call.
   * @returns {object|undefined} the record it was issued for.
   */
  take(token) {
    if (typeof token !== 'string' || token.length === 0) return undefined;
    const record = this.records.get(token);
    if (!record) return undefined;
    this.records.delete(token);
    if (record.expiresAt < this.now()) return undefined;
    return record;
  }

  /** Drop expired tokens, then the oldest ones beyond the limit. */
  #trim() {
    const now = this.now();
    for (const [token, record] of this.records) {
      if (record.expiresAt < now) this.records.delete(token);
    }
    while (this.records.size > this.limit) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }
}

/**
 * The answer of a first (refused) call: nothing was changed.
 * @param {object} record the issued record.
 * @returns {object} a payload meant for the agent to read.
 */
export function confirmationRequired(record) {
  return {
    status: 'confirmation-required',
    performed: false,
    action: record.action,
    target: record.target,
    risk: record.risk,
    summary: record.summary,
    confirm: record.token,
    expiresAt: new Date(record.expiresAt).toISOString(),
    instruction:
      `Nothing was changed. This ${record.risk} operation is waiting for a second confirmation: ` +
      `call the same tool again with confirm="${record.token}" within 3 minutes. ` +
      'Only do that when the human asked for this exact operation.',
  };
}

/**
 * Run a guarded action: ungated actions run directly, dangerous ones need the
 * token from a previous call.
 *
 * @param {ConfirmationStore} confirms the store.
 * @param {{args: object, instance: string, action: string, target: string|number, risk?: 'danger'|'destroy', summary: string}} spec
 * @param {() => Promise<any>} run the work, performed only after a valid token.
 * @returns {Promise<any>} the work's result, or the confirmation request.
 */
export async function runGuarded(confirms, spec, run) {
  const risk = spec.risk ?? 'danger';
  if (risk === 'safe') return run();
  const target = String(spec.target ?? '');
  const token = typeof spec.args?.confirm === 'string' ? spec.args.confirm.trim() : '';
  if (token.length > 0) {
    const record = confirms.take(token);
    if (!record) {
      throw new VmError(
        'the confirmation token is unknown, expired or already used — ask again and read the summary before confirming',
        'CONFIRM_EXPIRED',
      );
    }
    if (record.action !== spec.action || record.target !== target) {
      throw new VmError(
        `the confirmation token was issued for ${record.action} ${record.target || 'the instance'}, not for ${spec.action} ${target}`,
        'CONFIRM_MISMATCH',
      );
    }
    return run();
  }
  return confirmationRequired(
    confirms.issue({
      instance: spec.instance,
      action: spec.action,
      target,
      risk,
      summary: spec.summary,
    }),
  );
}
