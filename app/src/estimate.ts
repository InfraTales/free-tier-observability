/**
 * Monthly CloudWatch, X-Ray and Lambda estimate for one Lambda app, before and after the
 * always-free allowances. Prices are us-east-1 from the AWS Price List API (offer
 * AmazonCloudWatch 20261007115540, AWSXRay 20260911124622, AWSLambda 20261014171944).
 */

export const PRICES = {
  logIngestStandardPerGb: 0.5,
  logIngestInfrequentPerGb: 0.25,
  logStoragePerGbMonth: 0.03,
  /** CloudWatch stores logs compressed and bills 0.15 GB of storage per GB ingested. */
  storageCompressionRatio: 0.15,
  /** Custom metrics per month, by tier: [up to this many metrics, price each]. */
  customMetricTiers: [
    [10_000, 0.3],
    [250_000, 0.1],
    [1_000_000, 0.05],
    [Infinity, 0.02],
  ] as const,
  alarmMetricPerMonth: 0.1,
  compositeAlarmPerMonth: 0.5,
  dashboardPerMonth: 3,
  xrayTracePerRecorded: 0.000005,
  lambdaRequestArm: 0.0000002,
  lambdaGbSecondArm: 0.0000133334,
} as const;

export const FREE = {
  logIngestGb: 5,
  logStorageGb: 5,
  customMetrics: 10,
  alarmMetrics: 10,
  dashboards: 3,
  xrayTraces: 100_000,
  lambdaRequests: 1_000_000,
  lambdaGbSeconds: 400_000,
} as const;

/** 30 days. X-Ray's Lambda reservoir is 1 traced request per second. */
export const SECONDS_PER_MONTH = 30 * 24 * 3600;
/** We count a GB as 10^9 bytes. AWS may use 2^30; 10^9 overstates slightly, which is the safe side. */
export const BYTES_PER_GB = 1e9;

export interface EstimateInput {
  requestsPerMonth: number;
  /** Application log lines per request that pass the configured log level. */
  appLinesPerRequest: number;
  /** Average size of one application log line as Lambda writes it (with its JSON wrapper). */
  appLineBytes: number;
  /** Lambda's own platform lines per request (start + report). About 0 at system log level WARN. */
  systemBytesPerRequest: number;
  emfLinesPerRequest: number;
  emfLineBytes: number;
  retentionDays: number;
  logClass: 'STANDARD' | 'INFREQUENT_ACCESS';
  customMetricSeries: number;
  alarmMetrics: number;
  compositeAlarms: number;
  dashboards: number;
  tracing: boolean;
  memoryMb: number;
  avgDurationMs: number;
}

export interface EstimateLine {
  item: string;
  usage: number;
  unit: string;
  free: number;
  cost: number;
}

export interface Estimate {
  logIngestGb: number;
  logStoredGb: number;
  bytesPerRequest: number;
  xrayTracesUpperBound: number;
  lines: EstimateLine[];
  total: number;
  /** Items that cost money at this volume. Empty means everything stays inside the free tier. */
  overFreeTier: string[];
}

/** Tiered custom metric price for n metrics, less the 10 free ones. */
export function customMetricCost(n: number): number {
  const tiered = (count: number) => {
    let cost = 0;
    let floor = 0;
    for (const [ceiling, price] of PRICES.customMetricTiers) {
      if (count <= floor) break;
      cost += (Math.min(count, ceiling) - floor) * price;
      floor = ceiling;
    }
    return cost;
  };
  return tiered(n) - tiered(Math.min(n, FREE.customMetrics));
}

const over = (usage: number, free: number) => Math.max(0, usage - free);
const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Upper bound on traces Lambda records with active tracing: 1 per second plus 5% of the rest.
 * Traffic spread evenly gets this many; bursty traffic gets fewer.
 */
export function xrayTracesUpperBound(requests: number): number {
  if (requests <= SECONDS_PER_MONTH) return requests;
  return Math.round(SECONDS_PER_MONTH + 0.05 * (requests - SECONDS_PER_MONTH));
}

function validate(i: EstimateInput): void {
  for (const [k, v] of Object.entries(i)) {
    if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) throw new Error(`${k} must be a number >= 0`);
  }
  if (i.retentionDays < 1) throw new Error('retentionDays must be at least 1; a log group without retention keeps logs forever');
  if (i.logClass === 'INFREQUENT_ACCESS' && i.emfLinesPerRequest > 0) {
    throw new Error('the Infrequent Access log class does not extract EMF metrics; use STANDARD');
  }
}

export function estimate(i: EstimateInput): Estimate {
  validate(i);
  const bytesPerRequest = i.appLinesPerRequest * i.appLineBytes + i.systemBytesPerRequest + i.emfLinesPerRequest * i.emfLineBytes;
  const logIngestGb = (i.requestsPerMonth * bytesPerRequest) / BYTES_PER_GB;
  // Steady state: the log group holds `retentionDays` worth of logs, compressed.
  const logStoredGb = logIngestGb * (i.retentionDays / 30) * PRICES.storageCompressionRatio;
  const ingestPrice = i.logClass === 'STANDARD' ? PRICES.logIngestStandardPerGb : PRICES.logIngestInfrequentPerGb;
  const traces = i.tracing ? xrayTracesUpperBound(i.requestsPerMonth) : 0;
  const gbSeconds = i.requestsPerMonth * (i.avgDurationMs / 1000) * (i.memoryMb / 1024);

  const lines: EstimateLine[] = [
    { item: 'Log ingestion', usage: logIngestGb, unit: 'GB', free: FREE.logIngestGb, cost: over(logIngestGb, FREE.logIngestGb) * ingestPrice },
    { item: 'Log storage', usage: logStoredGb, unit: 'GB-month', free: FREE.logStorageGb, cost: over(logStoredGb, FREE.logStorageGb) * PRICES.logStoragePerGbMonth },
    { item: 'Custom metrics', usage: i.customMetricSeries, unit: 'metrics', free: FREE.customMetrics, cost: customMetricCost(i.customMetricSeries) },
    { item: 'Alarm metrics', usage: i.alarmMetrics, unit: 'alarm metrics', free: FREE.alarmMetrics, cost: over(i.alarmMetrics, FREE.alarmMetrics) * PRICES.alarmMetricPerMonth },
    { item: 'Composite alarms', usage: i.compositeAlarms, unit: 'alarms', free: 0, cost: i.compositeAlarms * PRICES.compositeAlarmPerMonth },
    { item: 'Dashboards', usage: i.dashboards, unit: 'dashboards', free: FREE.dashboards, cost: over(i.dashboards, FREE.dashboards) * PRICES.dashboardPerMonth },
    { item: 'X-Ray traces (upper bound)', usage: traces, unit: 'traces', free: FREE.xrayTraces, cost: over(traces, FREE.xrayTraces) * PRICES.xrayTracePerRecorded },
    { item: 'Lambda requests', usage: i.requestsPerMonth, unit: 'requests', free: FREE.lambdaRequests, cost: over(i.requestsPerMonth, FREE.lambdaRequests) * PRICES.lambdaRequestArm },
    { item: 'Lambda compute', usage: gbSeconds, unit: 'GB-seconds', free: FREE.lambdaGbSeconds, cost: over(gbSeconds, FREE.lambdaGbSeconds) * PRICES.lambdaGbSecondArm },
  ].map((l) => ({ ...l, cost: cents(l.cost) }));

  const total = cents(lines.reduce((s, l) => s + l.cost, 0));
  return {
    logIngestGb,
    logStoredGb,
    bytesPerRequest,
    xrayTracesUpperBound: traces,
    lines,
    total,
    overFreeTier: lines.filter((l) => l.cost > 0).map((l) => l.item),
  };
}

/** Requests per month at which log ingestion passes the 5 GB free allowance. */
export function requestsUntilLogsBill(bytesPerRequest: number): number {
  if (bytesPerRequest <= 0) return Infinity;
  return Math.floor((FREE.logIngestGb * BYTES_PER_GB) / bytesPerRequest);
}

/**
 * The orders app in this repo, per request, as measured by the tests:
 * - 1 application line at INFO: 168 bytes in the JSON shape Lambda documents (rounded to 170).
 * - Lambda's platform start + report lines: 534 bytes for the examples in the Lambda telemetry
 *   docs. Real lines carry extra fields (status, spans), so we assume 600. Measure yours.
 * - 2 EMF lines (Orders + StoreLatency): 296 and 305 bytes (rounded to 300 each).
 */
export const ORDERS_APP: EstimateInput = {
  requestsPerMonth: 1_000_000,
  appLinesPerRequest: 1,
  appLineBytes: 170,
  systemBytesPerRequest: 600,
  emfLinesPerRequest: 2,
  emfLineBytes: 300,
  retentionDays: 14,
  logClass: 'STANDARD',
  customMetricSeries: 6,
  alarmMetrics: 7,
  compositeAlarms: 0,
  dashboards: 1,
  tracing: true,
  memoryMb: 256,
  avgDurationMs: 50,
};
