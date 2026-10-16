import { estimate, type EstimateInput, FREE, ORDERS_APP, requestsUntilLogsBill, SECONDS_PER_MONTH, xrayTracesUpperBound } from '../../app/src/estimate';

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

test('a requestId dimension turns every request into a billed metric', () => {
  const e = estimate({ ...base, customMetricSeries: 1_000_000 });
  // Tiers: 10,000 at $0.30, 240,000 at $0.10, 750,000 at $0.05, less the 10 free.
  expect(e.lines.find((l) => l.item === 'Custom metrics')!.cost).toBe(64_497);
  expect(estimate({ ...base, customMetricSeries: 11 }).total).toBe(0.3);
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
});
