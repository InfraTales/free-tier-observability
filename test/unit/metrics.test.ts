import {
  catalogProblems,
  FREE_CUSTOM_METRICS,
  HIGH_CARDINALITY_NAMES,
  METRICS,
  NAMESPACE,
  seriesCount,
  type MetricCatalog,
} from '../../app/src/metric-catalog';
import { ORDERS_APP } from '../../app/src/estimate';
import { emfRecord, emitMetric } from '../../app/src/metrics';

describe('metric catalog', () => {
  test('publishes 6 metric series, inside the 10 free custom metrics', () => {
    expect(seriesCount(METRICS)).toBe(6);
    expect(seriesCount(METRICS)).toBeLessThanOrEqual(FREE_CUSTOM_METRICS);
  });

  test('has no high-cardinality dimension', () => {
    expect(catalogProblems(METRICS)).toEqual([]);
  });

  test('counts series as the product of dimension values', () => {
    const c: MetricCatalog = { A: { unit: 'Count', dimensions: { X: ['1', '2', '3'], Y: ['a', 'b'] } }, B: { unit: 'Count', dimensions: {} } };
    expect(seriesCount(c)).toBe(3 * 2 + 1);
  });

  test.each(HIGH_CARDINALITY_NAMES.slice(0, 4))('flags a %s dimension', (name) => {
    const c: MetricCatalog = { A: { unit: 'Count', dimensions: { [name]: ['x'] } } };
    expect(catalogProblems(c).join()).toMatch(/changes per request or user/);
  });

  test('flags a dimension with too many values, an empty one, and a repeated value', () => {
    const c: MetricCatalog = {
      A: { unit: 'Count', dimensions: { Tenant: ['a', 'b', 'c', 'd', 'e', 'f'] } },
      B: { unit: 'Count', dimensions: { Region: [] } },
      C: { unit: 'Count', dimensions: { Tier: ['x', 'x'] } },
    };
    const p = catalogProblems(c).join('\n');
    expect(p).toMatch(/Tenant has 6 values/);
    expect(p).toMatch(/Region lists no values/);
    expect(p).toMatch(/Tier repeats a value/);
  });
});

describe('EMF records', () => {
  const now = 1_760_000_000_000;

  test('match the EMF specification: root members, one dimension set, namespace and unit', () => {
    const r = emfRecord('Orders', 1, { Service: 'orders', Outcome: 'created' }, { requestId: 'r-1', orderId: 'o-1' }, now);
    expect(r).toEqual({
      _aws: {
        Timestamp: now,
        CloudWatchMetrics: [{ Namespace: NAMESPACE, Dimensions: [['Service', 'Outcome']], Metrics: [{ Name: 'Orders', Unit: 'Count' }] }],
      },
      Service: 'orders',
      Outcome: 'created',
      Orders: 1,
      requestId: 'r-1',
      orderId: 'o-1',
    });
  });

  test('keep requestId and orderId as plain fields, never as dimensions', () => {
    const r = emfRecord('StoreLatency', 12, { Service: 'orders', Operation: 'put' }, { requestId: 'r-1' }, now);
    const dims = r._aws.CloudWatchMetrics.flatMap((m) => m.Dimensions.flat());
    expect(dims).toEqual(['Service', 'Operation']);
    for (const d of dims) expect(HIGH_CARDINALITY_NAMES).not.toContain(d.toLowerCase());
  });

  test('reject a value the catalog does not list', () => {
    expect(() => emfRecord('Orders', 1, { Service: 'orders', Outcome: 'refunded' as 'created' }, {}, now)).toThrow(/Outcome=refunded/);
  });

  test('reject an extra dimension, such as requestId', () => {
    const dims = { Service: 'orders', Outcome: 'created', requestId: 'r-1' } as unknown as { Service: 'orders'; Outcome: 'created' };
    expect(() => emfRecord('Orders', 1, dims, {}, now)).toThrow(/dimension requestId is not in the catalog/);
  });

  test('reject a missing dimension, a non-finite value and a colliding field', () => {
    expect(() => emfRecord('Orders', 1, { Service: 'orders' } as never, {}, now)).toThrow(/missing dimension Outcome/);
    expect(() => emfRecord('Orders', Number.NaN, { Service: 'orders', Outcome: 'created' }, {}, now)).toThrow(/finite/);
    expect(() => emfRecord('Orders', 1, { Service: 'orders', Outcome: 'created' }, { Outcome: 'x' }, now)).toThrow(/collide/);
  });
});

describe('emitMetric', () => {
  test('writes exactly one JSON line, ending in a newline', () => {
    const lines: string[] = [];
    expect(emitMetric('ColdStart', 1, { Service: 'orders' }, {}, (l) => lines.push(l))).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    expect(lines[0]!.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(lines[0]!)).toHaveProperty('_aws.CloudWatchMetrics');
  });

  test('writes to stdout directly, not through console.log', () => {
    // With Lambda's JSON log format, console.log wraps the line and CloudWatch no longer sees the EMF block.
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      emitMetric('ColdStart', 1, { Service: 'orders' });
      expect(write).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      log.mockRestore();
    }
  });

  test('drops a bad metric with an error log instead of throwing', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const lines: string[] = [];
    try {
      expect(emitMetric('Orders', 1, { Service: 'orders', Outcome: 'nope' as 'created' }, {}, (l) => lines.push(l))).toBe(false);
      expect(lines).toEqual([]);
      expect(err).toHaveBeenCalledWith(expect.objectContaining({ msg: 'metric dropped', metric: 'Orders' }));
    } finally {
      err.mockRestore();
    }
  });

  test('an EMF line is about 300 bytes, the size the estimate uses', () => {
    const r = emfRecord('Orders', 1, { Service: 'orders', Outcome: 'duplicate' }, { requestId: '6d68ca91-49c9-448d-89b8-7ca3e6dc66aa', orderId: 'ord-0000000001' });
    const bytes = Buffer.byteLength(JSON.stringify(r) + '\n');
    expect(bytes).toBeGreaterThan(250);
    expect(bytes).toBeLessThanOrEqual(ORDERS_APP.emfLineBytes + 10);
  });
});
