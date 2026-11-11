/**
 * VM read-only detail: RRD statistics and the "can this feature run here?"
 * probe.
 *
 * Both endpoints exist on PVE 7.4 (`{vmid}/rrddata` is GET with a required
 * `timeframe`, `{vmid}/feature` is GET with a required `feature`). They answer
 * questions the rest of the plugin otherwise discovers by trying an operation
 * and failing: is there enough history for a chart, can this disk be snapshotted
 * or cloned, which node would run the task.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

const TIMEFRAMES = ['hour', 'day', 'week', 'month', 'year'];
const FEATURES = ['snapshot', 'clone', 'copy'];

/** Normalise the consolidation function to the two values PVE accepts. */
function consolidation(value) {
  const cf = String(value ?? 'AVERAGE').toUpperCase();
  if (cf !== 'AVERAGE' && cf !== 'MAX') throw new VmError(`cf must be AVERAGE or MAX, not "${value}"`, 'BAD_ARGUMENT');
  return cf;
}

/**
 * Build the VM detail tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function vmDetailTools(deps) {
  return [
    {
      name: 'vm_detail',
      description:
        'Read-only VM detail. `rrddata` returns the RRD history (timeframe hour/day/week/month/year, consolidation ' +
        'AVERAGE or MAX); `feature` asks PVE whether the VM supports snapshot, clone or copy — check it before acting ' +
        'so an unsupported operation is explained instead of failing halfway.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        action: { type: 'string', enum: ['rrddata', 'feature'], required: true, description: 'What to read.' },
        timeframe: {
          type: 'string',
          enum: TIMEFRAMES,
          description: 'RRD timeframe for action=rrddata (default hour).',
        },
        cf: { type: 'string', description: 'RRD consolidation function for action=rrddata: AVERAGE (default) or MAX.' },
        feature: {
          type: 'string',
          enum: FEATURES,
          description: 'Feature to check for action=feature: snapshot, clone or copy.',
        },
        snapname: { type: 'string', description: 'Snapshot name for action=feature (optional).' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.action === 'feature') {
            const supported = value.supported ? 'supported' : 'NOT supported';
            const nodes = Array.isArray(value.nodes) && value.nodes.length > 0 ? ` on ${value.nodes.join(', ')}` : '';
            return textOutput(`VM ${value.vmid} feature "${value.feature}": ${supported}${nodes}`);
          }
          const samples = Array.isArray(value.data) ? value.data : [];
          const last = samples.at(-1);
          return textOutput(
            `VM ${value.vmid} RRD ${value.timeframe}/${value.cf}: ${samples.length} samples` +
              (last ? `; last at ${last.time ?? '?'}: ${JSON.stringify(last)}` : ''),
          );
        },
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const node = await controller.nodeFor(vmid, { signal: exec?.signal });
        if (args.action === 'rrddata') {
          const timeframe = String(args.timeframe ?? 'hour');
          if (!TIMEFRAMES.includes(timeframe)) throw new VmError(`unknown timeframe "${timeframe}"`, 'BAD_ARGUMENT');
          const cf = consolidation(args.cf);
          const data = await controller.pveshGet(
            `/nodes/${node}/qemu/${vmid}/rrddata`,
            { timeframe, cf },
            { signal: exec?.signal },
          );
          return { instance: name, vmid, node, action: 'rrddata', timeframe, cf, data };
        }
        const feature = String(args.feature ?? '');
        if (!FEATURES.includes(feature)) throw new VmError(`unknown feature "${feature}"`, 'BAD_ARGUMENT');
        const query = { feature, ...(args.snapname ? { snapname: String(args.snapname) } : {}) };
        const result = await controller.pveshGet(
          `/nodes/${node}/qemu/${vmid}/feature`,
          query,
          { signal: exec?.signal },
        );
        return {
          instance: name,
          vmid,
          node,
          action: 'feature',
          feature,
          supported: Number(result?.hasFeature ?? 0) === 1,
          nodes: Array.isArray(result?.nodes) ? result.nodes : [],
        };
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
