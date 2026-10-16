/**
 * The real bundle (build/orders/index.js) against DynamoDB Local.
 *
 *   docker run -d --rm -p 8016:8000 amazon/dynamodb-local:3.3.2
 *   AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8016 npm run test:int
 */
import * as path from 'node:path';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BUNDLE_DIR } from '../../infra/lib/orders-stack';

if (!process.env.AWS_ENDPOINT_URL_DYNAMODB) throw new Error('set AWS_ENDPOINT_URL_DYNAMODB to DynamoDB Local');
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'AKIAIOSFODNN7EXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY ??= 'local';

const table = `orders-${Date.now()}`;
process.env.ORDERS_TABLE = table;
const ddb = new DynamoDBClient({});

type Handler = (e: unknown, c: { awsRequestId: string }) => Promise<{ statusCode: number; body: Record<string, unknown> }>;
const { handler } = require(path.join(BUNDLE_DIR, 'index.js')) as { handler: Handler };

let lines: string[] = [];
let write: jest.SpyInstance;

beforeAll(async () => {
  await ddb.send(
    new CreateTableCommand({
      TableName: table,
      AttributeDefinitions: [{ AttributeName: 'orderId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'orderId', KeyType: 'HASH' }],
      ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 2 },
    }),
  );
});
afterAll(async () => {
  await ddb.send(new DeleteTableCommand({ TableName: table }));
  ddb.destroy();
});
beforeEach(() => {
  lines = [];
  write = jest.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    lines.push(String(s));
    return true;
  });
  for (const m of ['debug', 'info', 'warn', 'error'] as const) jest.spyOn(console, m).mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const emf = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const ctx = (n: number) => ({ awsRequestId: `req-${n}` });

test('create, read back, and refuse a second create of the same order', async () => {
  const order = { orderId: 'ord-int-1', customerId: 'cus-1', amountCents: 999 };
  expect((await handler({ action: 'create', order }, ctx(1))).statusCode).toBe(201);
  expect((await handler({ action: 'create', order }, ctx(2))).statusCode).toBe(409);
  const got = await handler({ action: 'get', orderId: 'ord-int-1' }, ctx(3));
  expect(got.statusCode).toBe(200);
  expect(got.body).toMatchObject(order);
  expect(emf().filter((m) => 'Orders' in m).map((m) => m.Outcome)).toEqual(['created', 'duplicate']);
  expect(write).toHaveBeenCalled();
});

test('20 concurrent creates of one order: exactly one wins, 19 are counted as duplicates', async () => {
  const order = { orderId: 'ord-race', customerId: 'cus-2', amountCents: 100 };
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => handler({ action: 'create', order }, ctx(100 + i))));
  const codes = results.map((r) => r.statusCode).sort();
  expect(codes.filter((c) => c === 201)).toHaveLength(1);
  expect(codes.filter((c) => c === 409)).toHaveLength(19);
  const outcomes = emf().filter((m) => 'Orders' in m).map((m) => m.Outcome);
  expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
  expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(19);
});

test('every line the bundle writes to stdout is one complete EMF record', async () => {
  await handler({ action: 'create', order: { orderId: 'ord-int-2', customerId: 'cus-3', amountCents: 5 } }, ctx(200));
  await handler({ action: 'get', orderId: 'missing' }, ctx(201));
  expect(lines.length).toBeGreaterThanOrEqual(3);
  for (const l of lines) {
    expect(l.endsWith('\n')).toBe(true);
    const r = JSON.parse(l) as { _aws: { CloudWatchMetrics: { Namespace: string; Metrics: { Name: string }[] }[] } } & Record<string, unknown>;
    const def = r._aws.CloudWatchMetrics[0]!;
    expect(def.Namespace).toBe('InfraTales/Orders');
    expect(typeof r[def.Metrics[0]!.Name]).toBe('number');
  }
  expect(emf().filter((m) => m.Operation === 'get')).toHaveLength(1);
});
