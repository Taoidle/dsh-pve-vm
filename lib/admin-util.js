/**
 * Small validators shared by the "extra" tool modules.
 *
 * These modules mostly pass identifiers straight into an API path, so the
 * checks live here instead of being copied into every file: a wrong id should
 * fail before a request is sent, and a feature a PVE release does not have
 * should be reported as unavailable instead of as a failed command.
 */
import { VmError } from './session.js';
import { parseAssignments } from './tool-output.js';

/** Trim a required string, with a readable error. */
export function requireText(value, label, maxLength = 4096) {
  const text = String(value ?? '').trim();
  if (text.length === 0) throw new VmError(`${label} is required`, 'BAD_ARGUMENT');
  if (text.length > maxLength) throw new VmError(`${label} is longer than ${maxLength} characters`, 'BAD_ARGUMENT');
  if (text.includes('\0')) throw new VmError(`${label} contains a control character`, 'BAD_ARGUMENT');
  return text;
}

/** Require a non-empty block, but keep its whitespace (PEM, hosts files, scripts). */
export function requireBlock(value, label, maxLength = 65536) {
  const text = String(value ?? '');
  if (text.trim().length === 0) throw new VmError(`${label} is required`, 'BAD_ARGUMENT');
  if (text.length > maxLength) throw new VmError(`${label} is longer than ${maxLength} characters`, 'BAD_ARGUMENT');
  if (text.includes('\0')) throw new VmError(`${label} contains a control character`, 'BAD_ARGUMENT');
  return text;
}

/** Trim a required string and check it against a pattern. */
export function matchText(value, label, pattern, hint = '') {
  const text = requireText(value, label);
  if (!pattern.test(text)) {
    throw new VmError(`${label} "${text}" is not valid${hint ? ` — ${hint}` : ''}`, 'BAD_ARGUMENT');
  }
  return text;
}

/** Optional trimmed string; undefined when empty. */
export function optionalText(value) {
  const text = String(value ?? '').trim();
  return text.length === 0 ? undefined : text;
}

/** `["key=value", "key"]` → `{key: "value"}`; a bare key maps to an empty string. */
export function assignments(pairs) {
  const out = {};
  for (const { key, value } of parseAssignments(pairs ?? [])) out[key] = value;
  return out;
}

/** The node to work on: the argument, else the instance's node. */
export async function nodeOf(controller, args) {
  const explicit = optionalText(args?.node);
  if (explicit === undefined) return await controller.nodeName();
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(explicit)) {
    throw new VmError(`node "${explicit}" is not a valid node name`, 'BAD_ARGUMENT');
  }
  return explicit;
}

/**
 * True when the API answered "this endpoint does not exist here".
 *
 * `asVmError` keeps only the message, so the status has to be read out of it;
 * `pvesh` over ssh says "no such resource" instead of an HTTP status.
 */
export function isUnavailable(error) {
  if (error?.status === 404 || error?.status === 501) return true;
  const message = String(error?.message ?? error ?? '');
  return /HTTP (404|501)\b|no such resource|not implemented|unknown method|does not exist/i.test(message);
}

/** A consistent answer for a feature this PVE release does not expose. */
export function unavailable(feature, note) {
  return {
    available: false,
    feature,
    note: note ?? `${feature} is not available on this PVE version.`,
  };
}

/** True for a boolean-ish value the API accepts (1/0/true/false). */
export function flag(value) {
  if (value === undefined || value === null) return undefined;
  return value ? 1 : 0;
}

/** A finite number, or a BAD_ARGUMENT error. */
export function numberParam(value, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new VmError(`${label} must be a number`, 'BAD_ARGUMENT');
  if (integer && !Number.isInteger(number)) throw new VmError(`${label} must be an integer`, 'BAD_ARGUMENT');
  if (number < min || number > max) throw new VmError(`${label} must be between ${min} and ${max}`, 'BAD_ARGUMENT');
  return number;
}

/** Escape one path segment for an API path. */
export function segment(value) {
  return encodeURIComponent(String(value));
}
