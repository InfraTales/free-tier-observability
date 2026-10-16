/**
 * Every custom metric this app may publish, with every value each dimension may take.
 *
 * CloudWatch bills one custom metric for each unique combination of metric name and
 * dimension values. Listing the values here means the count is known before deploy,
 * and both the app (EMF writer) and the stack (alarms, dashboard) read from this file.
 */

export type MetricUnit = 'Count' | 'Milliseconds';

export interface MetricSpec {
  readonly unit: MetricUnit;
  /** Dimension name to the complete list of values it may take. One dimension set per metric. */
  readonly dimensions: Readonly<Record<string, readonly string[]>>;
}

export type MetricCatalog = Readonly<Record<string, MetricSpec>>;

export const NAMESPACE = 'InfraTales/Orders';
export const SERVICE = 'orders';

export const METRICS = {
  // 1 x 3 = 3 series
  Orders: { unit: 'Count', dimensions: { Service: [SERVICE], Outcome: ['created', 'duplicate', 'rejected'] } },
  // 1 x 2 = 2 series
  StoreLatency: { unit: 'Milliseconds', dimensions: { Service: [SERVICE], Operation: ['put', 'get'] } },
  // 1 series
  ColdStart: { unit: 'Count', dimensions: { Service: [SERVICE] } },
} as const satisfies MetricCatalog;

/** The free tier covers 10 custom metrics a month. */
export const FREE_CUSTOM_METRICS = 10;

/** Dimension names that take a new value per request or per user. Each value is a new billed metric. */
export const HIGH_CARDINALITY_NAMES = [
  'requestid',
  'awsrequestid',
  'traceid',
  'orderid',
  'userid',
  'customerid',
  'sessionid',
  'email',
  'ip',
  'sourceip',
  'path',
  'url',
  'timestamp',
];

/** A dimension with more values than this is treated as high cardinality, whatever its name. */
export const MAX_VALUES_PER_DIMENSION = 5;

/** Number of billed metric series: for each metric, the product of its dimension value counts. */
export function seriesCount(catalog: MetricCatalog): number {
  return Object.values(catalog).reduce(
    (total, spec) => total + Object.values(spec.dimensions).reduce((n, values) => n * values.length, 1),
    0,
  );
}

/** Problems that would make the metric count unbounded or surprising. Empty means fine. */
export function catalogProblems(catalog: MetricCatalog): string[] {
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(catalog)) {
    for (const [dim, values] of Object.entries(spec.dimensions)) {
      if (HIGH_CARDINALITY_NAMES.includes(dim.toLowerCase())) {
        problems.push(`${name}: dimension ${dim} changes per request or user; log it as a field instead`);
      }
      if (values.length === 0) problems.push(`${name}: dimension ${dim} lists no values`);
      if (values.length > MAX_VALUES_PER_DIMENSION) {
        problems.push(`${name}: dimension ${dim} has ${values.length} values (max ${MAX_VALUES_PER_DIMENSION})`);
      }
      if (new Set(values).size !== values.length) problems.push(`${name}: dimension ${dim} repeats a value`);
    }
  }
  return problems;
}
