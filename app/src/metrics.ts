/**
 * CloudWatch embedded metric format (EMF) writer, limited to the metrics in metric-catalog.ts.
 *
 * Two Lambda details shape this file:
 * - With the JSON log format, Lambda wraps console.log output in its own JSON object, and
 *   CloudWatch can't find the EMF block any more. AWS's fix is to write EMF lines straight to stdout.
 * - A raw stdout line with no "level" key counts as INFO. If the function's application log
 *   level is WARN or higher, Lambda drops these lines and the metrics vanish. The stack
 *   refuses that combination.
 */
import { METRICS, NAMESPACE } from './metric-catalog';

type Catalog = typeof METRICS;
export type MetricName = keyof Catalog;
export type DimensionsOf<M extends MetricName> = {
  -readonly [K in keyof Catalog[M]['dimensions']]: Catalog[M]['dimensions'][K] extends readonly (infer V)[] ? V : never;
};

export interface EmfRecord {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: { Namespace: string; Dimensions: string[][]; Metrics: { Name: string; Unit: string }[] }[];
  };
  [key: string]: unknown;
}

/**
 * Build one EMF log record. Throws if a dimension is missing, extra, or has a value the
 * catalog doesn't list. `fields` are plain log fields (like requestId): searchable in
 * Logs Insights, and never turned into metrics.
 */
export function emfRecord<M extends MetricName>(
  name: M,
  value: number,
  dimensions: DimensionsOf<M>,
  fields: Record<string, string | number | boolean> = {},
  now: number = Date.now(),
): EmfRecord {
  const spec = METRICS[name] as { unit: string; dimensions: Record<string, readonly string[]> };
  if (!spec) throw new Error(`unknown metric ${String(name)}`);
  if (!Number.isFinite(value)) throw new Error(`${String(name)}: value must be a finite number`);

  const given = dimensions as Record<string, string>;
  const allowed = Object.keys(spec.dimensions);
  for (const key of Object.keys(given)) {
    if (!allowed.includes(key)) throw new Error(`${String(name)}: dimension ${key} is not in the catalog`);
  }
  for (const key of allowed) {
    const v = given[key];
    if (v === undefined) throw new Error(`${String(name)}: missing dimension ${key}`);
    if (!spec.dimensions[key]!.includes(v)) throw new Error(`${String(name)}: ${key}=${v} is not an allowed value`);
  }
  for (const key of Object.keys(fields)) {
    if (key === '_aws' || allowed.includes(key) || key === name) {
      throw new Error(`${String(name)}: field ${key} would collide with a metric or dimension`);
    }
  }

  return {
    ...fields,
    ...given,
    [name]: value,
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [{ Namespace: NAMESPACE, Dimensions: [allowed], Metrics: [{ Name: String(name), Unit: spec.unit }] }],
    },
  };
}

export type Writer = (line: string) => void;
const stdout: Writer = (line) => {
  process.stdout.write(line);
};

/**
 * Write one metric. Never throws: a bad metric call logs an error and returns false,
 * so it can't fail the request it was measuring.
 */
export function emitMetric<M extends MetricName>(
  name: M,
  value: number,
  dimensions: DimensionsOf<M>,
  fields: Record<string, string | number | boolean> = {},
  write: Writer = stdout,
): boolean {
  try {
    write(JSON.stringify(emfRecord(name, value, dimensions, fields)) + '\n');
    return true;
  } catch (err) {
    console.error({ msg: 'metric dropped', metric: String(name), error: (err as Error).message });
    return false;
  }
}
