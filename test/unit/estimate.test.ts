import { customMetricCost, estimate, type EstimateInput, FREE, HOURS_PER_MONTH, ORDERS_APP, requestsUntilLogsBill, SECONDS_PER_MONTH, xrayTracesUpperBound } from '../../app/src/estimate';

const base: EstimateInput = { ...ORDERS_APP, tracing: false };

test('1 million requests a month stays at $0 without tracing', () => {
  const e = estimate(base);
  expect(e.bytesPerRequest).toBe(170 + 600 + 600);
  expect(e.logIngestGb).toBeCloseTo(1.37, 5);
  expect(e.logStoredGb).toBeCloseTo(1.37 * (14 / 30) * 0.15, 5);
  expect(e.total).toBe(0);
  expect(e.overFreeTier).toEqual([]);
});

test('logs pass the 5 GB free ingestion at about 3.6 million requests, and bill $0.50 per GB after', () => {
  expect(requestsUntilLogsBill(1370)).toBe(3_649_635);
  const e = estimate({ ...base, requestsPerMonth: 10_000_000 });
  const ingest = e.lines.find((l) => l.item === 'Log ingestion')!;
  expect(ingest.usage).toBeCloseTo(13.7, 5);
  expect(ingest.cost).toBe(4.35); // (13.7 - 5) GB x $0.50
  expect(e.overFreeTier).toContain('Log ingestion');
});

test('system log level WARN removes most of the bytes per request', () => {
  const info = estimate(base).bytesPerRequest;
  const warn = estimate({ ...base, systemBytesPerRequest: 0 }).bytesPerRequest;
  expect(warn / info).toBeCloseTo(770 / 1370, 5);
});

test('X-Ray is the first thing to bill: up to every request is traced at under 1 per second', () => {
  expect(xrayTracesUpperBound(1_000_000)).toBe(1_000_000);
  expect(xrayTracesUpperBound(SECONDS_PER_MONTH + 1_000_000)).toBe(SECONDS_PER_MONTH + 50_000);
  const e = estimate({ ...base, tracing: true });
  const xray = e.lines.find((l) => l.item.startsWith('X-Ray'))!;
  expect(xray.cost).toBe(4.5); // (1,000,000 - 100,000) x $0.000005
  expect(e.overFreeTier).toEqual(['X-Ray traces (upper bound)']);
  expect(estimate({ ...base, tracing: true, requestsPerMonth: FREE.xrayTraces }).total).toBe(0);
});

test('an 11th alarm metric costs $0.10 and a composite alarm $0.50', () => {
  const e = estimate({ ...base, alarmMetrics: 11, compositeAlarms: 1 });
  expect(e.lines.find((l) => l.item === 'Alarm metrics')!.cost).toBe(0.1);
  expect(e.lines.find((l) => l.item === 'Composite alarms')!.cost).toBe(0.5);
  expect(e.total).toBe(0.6);
});

// Price List API, AmazonCloudWatch us-east-1, CW:MetricMonitorUsage: $0.30 per metric-month for the
// first 10,000, $0.10 for the next 240,000, $0.05 for the next 750,000, $0.02 after. 10 are free.
// The pricing page: custom metrics are "prorated by the hour", billed only in hours they get data.
const tieredByHand = (metricMonths: number) =>
  0.3 * Math.min(metricMonths, 10_000) +
  0.1 * Math.max(0, Math.min(metricMonths, 250_000) - 10_000) +
  0.05 * Math.max(0, Math.min(metricMonths, 1_000_000) - 250_000) +
  0.02 * Math.max(0, metricMonths - 1_000_000);
const byHand = (metricMonths: number) => Math.round((tieredByHand(metricMonths) - tieredByHand(Math.min(metricMonths, 10))) * 100) / 100;
const metricCost = (e: ReturnType<typeof estimate>) => e.lines.find((l) => l.item === 'Custom metrics')!.cost;

test('metrics sent all month bill the full tiered price', () => {
  expect(HOURS_PER_MONTH).toBe(730);
  expect(metricCost(estimate({ ...base, customMetricSeries: 11 }))).toBe(0.3);
  expect(estimate({ ...base, customMetricSeries: 11 }).total).toBe(0.3);
  for (const n of [6, 10, 11, 10_000, 250_000, 1_000_000, 2_000_000]) {
    expect(metricCost(estimate({ ...base, customMetricSeries: n }))).toBeCloseTo(byHand(n), 2);
    expect(customMetricCost(n)).toBeCloseTo(byHand(n), 2);
  }
  // 1 million always-on metrics: 9,990 x $0.30 + 240,000 x $0.10 + 750,000 x $0.05.
  expect(customMetricCost(1_000_000)).toBeCloseTo(9_990 * 0.3 + 240_000 * 0.1 + 750_000 * 0.05, 6);
});

test('a requestId dimension makes a million one-off metrics, each billed for the 1 hour it gets data', () => {
  const e = estimate({ ...base, customMetricSeries: 1_000_000, customMetricHoursPerMonth: 1 });
  const line = e.lines.find((l) => l.item === 'Custom metrics')!;
  expect(line.usage).toBeCloseTo(1_000_000 / 730, 6); // about 1,370 metric-months
  expect(line.unit).toBe('metric-months');
  // All inside the first tier: (1,000,000 / 730 - 10) x $0.30, about $408.
  expect(line.cost).toBeCloseTo((1_000_000 / 730 - 10) * 0.3, 2);
  expect(line.cost).toBe(byHand(1_000_000 / 730));
  expect(line.cost).toBeGreaterThan(400);
  expect(line.cost).toBeLessThan(420);
});

test('one-off metrics are not billed for a full month each', () => {
  // Billing every metric for 730 hours would charge $64,497 here; proration charges about $408.
  const fullMonth = byHand(1_000_000);
  expect(fullMonth).toBe(64_497);
  const prorated = metricCost(estimate({ ...base, customMetricSeries: 1_000_000, customMetricHoursPerMonth: 1 }));
  expect(prorated).toBeLessThan(fullMonth / 100);
  // 20 metrics sent for half the month are 10 metric-months, all free; 22 are 11, one billed.
  expect(customMetricCost(20, 365)).toBe(0);
  expect(customMetricCost(22, 365)).toBeCloseTo(0.3, 6);
});

test('rejects more custom metric hours than a month has', () => {
  expect(() => estimate({ ...base, customMetricHoursPerMonth: 731 })).toThrow(/at most 730/);
});

test('a fourth dashboard costs $3', () => {
  expect(estimate({ ...base, dashboards: 4 }).total).toBe(3);
});

test('Infrequent Access halves ingestion, but refuses EMF', () => {
  expect(() => estimate({ ...base, logClass: 'INFREQUENT_ACCESS' })).toThrow(/does not extract EMF/);
  const e = estimate({ ...base, logClass: 'INFREQUENT_ACCESS', emfLinesPerRequest: 0, requestsPerMonth: 20_000_000 });
  const ingest = e.lines.find((l) => l.item === 'Log ingestion')!;
  expect(ingest.cost).toBeCloseTo((ingest.usage - 5) * 0.25, 2);
});

test('rejects missing retention and negative inputs', () => {
  expect(() => estimate({ ...base, retentionDays: 0 })).toThrow(/forever/);
  expect(() => estimate({ ...base, requestsPerMonth: -1 })).toThrow(/requestsPerMonth/);
});

test('an application log line is about 150 bytes in the JSON shape Lambda documents', () => {
  // Shape from the Lambda docs' Node.js JSON log example, with this app's message.
  const line = JSON.stringify({
    timestamp: '2025-11-01T00:21:51.358Z',
    level: 'INFO',
    requestId: '93f25699-2cbf-4976-8f94-336a0aa98c6f',
    message: { msg: 'order created', orderId: 'ord-0000000001' },
  });
  expect(Buffer.byteLength(line + '\n')).toBeLessThanOrEqual(base.appLineBytes);
});

describe('estimate CLI', () => {
  const { parseArgs, report } = require('../../scripts/estimate') as typeof import('../../scripts/estimate');

  test('overrides numbers and booleans, and rejects unknown or malformed input', () => {
    const i = parseArgs(['--requestsPerMonth=5_000_000', '--tracing=false']);
    expect(i.requestsPerMonth).toBe(5_000_000);
    expect(i.tracing).toBe(false);
    expect(() => parseArgs(['--requests=5'])).toThrow(/unknown input requests/);
    expect(() => parseArgs(['--tracing=yes'])).toThrow(/true or false/);
    expect(() => parseArgs(['--memoryMb=lots'])).toThrow(/number/);
    expect(() => parseArgs(['memoryMb=1'])).toThrow(/--name=value/);
  });

  test('prints a table and where logs start to bill', () => {
    const out = report(parseArgs(['--tracing=false']));
    expect(out).toMatch(/\| Log ingestion \| 1\.370 GB \| 5 \| \$0\.00 \|/);
    expect(out).toMatch(/passes the free 5 GB at 3,649,635 requests/);
    expect(out).toMatch(/inside the always-free tier/);
  });

  test('prints prorated custom metrics for one-off metrics', () => {
    const out = report(parseArgs(['--customMetricSeries=1_000_000', '--customMetricHoursPerMonth=1']));
    expect(out).toMatch(/\| Custom metrics \| 1369\.863 metric-months \| 10 \| \$407\.96 \|/);
  });
});
