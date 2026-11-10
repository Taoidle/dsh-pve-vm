/**
 * `.volatile()` for a bare checkout.
 *
 * The harness patches schemastery: a `.volatile()` field is handed out by the
 * settings service as a live reference, which is why `lib/config.js` marks
 * `instances` and `defaultInstance` that way. The standalone package resolved by
 * `node_modules` in a checkout has no such method, so importing `lib/config.js`
 * from a dev script dies at the first `volatile()` call.
 *
 * Import this module BEFORE `lib/config.js` (the class is patched through the
 * shared module instance, so the patch lands where config.js looks). Inside a
 * profile the real method exists and this is a no-op.
 */
import z from '@deepseek-ai/schemastery';

const proto = Object.getPrototypeOf(z.string());
if (typeof proto.volatile !== 'function') {
  /** Marks the field as a live reference; the shim itself keeps it plain. */
  Object.defineProperty(proto, 'volatile', {
    value: function volatile() {
      return this;
    },
    writable: true,
    configurable: true,
  });
}
