/**
 * Shared output plumbing for the tools that return plain JSON.
 *
 * Every tool has to declare `output: { schema, render }`: the harness compiles an
 * author definition into a schema and a model-facing schema in one step, and a
 * tool without an output schema does not activate at all. The administrative
 * tools all return "a structured answer", so one permissive object schema plus
 * one renderer keeps the noise out of the tool files.
 */

/** Output schema for a free-form object answer. */
export const PLAIN_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {},
};

/** A text-only response. */
export function textOutput(text) {
  return [{ type: 'text', text }];
}

/** Render a value as pretty JSON — the answer of the generic tools. */
export function renderValue(args, value) {
  return textOutput(JSON.stringify(value, null, 2));
}

/** Render a value with a leading line, so the agent sees the outcome first. */
export function renderWithLine(line, value) {
  return textOutput(`${line}\n${JSON.stringify(value, null, 2)}`);
}

/**
 * Turn `["memory=4096", "name=web"]` into `{memory: "4096", name: "web"}`.
 * A bare `key` (no `=`) becomes an empty value, which the `qm set` path reads as
 * "delete this property".
 * @param {string[]|undefined} pairs the settings the caller passed.
 * @returns {Array<{key: string, value: string}>} the parsed pairs.
 */
export function parseAssignments(pairs) {
  if (!Array.isArray(pairs)) return [];
  return pairs.map((entry) => {
    const text = String(entry ?? '');
    const at = text.indexOf('=');
    if (at < 0) return { key: text.trim(), value: '' };
    return { key: text.slice(0, at).trim(), value: text.slice(at + 1) };
  });
}
