/**
 * Estimate a month of CloudWatch, X-Ray and Lambda for a Lambda app.
 *
 *   npm run estimate
 *   npm run estimate -- --requestsPerMonth=5000000 --systemBytesPerRequest=0 --tracing=false
 *
 * Any field of EstimateInput can be overridden. Defaults describe the orders app in this repo.
 */
import { estimate, type EstimateInput, ORDERS_APP, requestsUntilLogsBill } from '../app/src/estimate';

export function parseArgs(argv: string[], defaults: EstimateInput = ORDERS_APP): EstimateInput {
  const input: Record<string, unknown> = { ...defaults };
  for (const arg of argv) {
    const m = /^--([A-Za-z]+)=(.*)$/.exec(arg);
    if (!m) throw new Error(`expected --name=value, got ${arg}`);
    const [, key, raw] = m as unknown as [string, string, string];
    if (!(key in defaults)) throw new Error(`unknown input ${key}. Known: ${Object.keys(defaults).join(', ')}`);
    const current = (defaults as unknown as Record<string, unknown>)[key];
    if (typeof current === 'number') {
      const n = Number(raw.replace(/_/g, ''));
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
      input[key] = n;
    } else if (typeof current === 'boolean') {
      if (raw !== 'true' && raw !== 'false') throw new Error(`${key} must be true or false`);
      input[key] = raw === 'true';
    } else {
      input[key] = raw;
    }
  }
  return input as unknown as EstimateInput;
}

export function report(input: EstimateInput): string {
  const e = estimate(input);
  const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(3));
  const rows = e.lines.map((l) => `| ${l.item} | ${fmt(l.usage)} ${l.unit} | ${fmt(l.free)} | $${l.cost.toFixed(2)} |`);
  return [
    `Requests: ${input.requestsPerMonth.toLocaleString('en-US')} a month, ${e.bytesPerRequest} log bytes each`,
    '',
    '| Item | Usage | Free | Cost |',
    '|---|---|---|---|',
    ...rows,
    `| Total | | | $${e.total.toFixed(2)} |`,
    '',
    `Log ingestion passes the free 5 GB at ${requestsUntilLogsBill(e.bytesPerRequest).toLocaleString('en-US')} requests a month.`,
    e.overFreeTier.length ? `Over the free tier: ${e.overFreeTier.join(', ')}.` : 'Everything here is inside the always-free tier.',
  ].join('\n');
}

if (require.main === module) {
  try {
    console.log(report(parseArgs(process.argv.slice(2))));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
