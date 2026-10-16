import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { handler, parseOrder, resetForTests } from '../../app/src/orders';

const ddb = mockClient(DynamoDBDocumentClient);
const ctx = { awsRequestId: 'req-1' };
const order = { orderId: 'ord-1', customerId: 'cus-1', amountCents: 1250 };
let out: string[];
let write: jest.SpyInstance;

beforeEach(() => {
  ddb.reset();
  resetForTests();
  process.env.ORDERS_TABLE = 'Orders';
  out = [];
  write = jest.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    out.push(String(s));
    return true;
  });
  for (const m of ['debug', 'info', 'warn', 'error'] as const) jest.spyOn(console, m).mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const metrics = () => out.map((l) => JSON.parse(l) as Record<string, unknown>);
const outcome = () => metrics().filter((m) => 'Orders' in m).map((m) => m.Outcome);

test('parseOrder accepts a valid order and names the bad field otherwise', () => {
  expect(parseOrder(order)).toEqual(order);
  expect(parseOrder(null)).toMatch(/object/);
  expect(parseOrder({ ...order, orderId: 'a b' })).toMatch(/orderId/);
  expect(parseOrder({ ...order, customerId: '' })).toMatch(/customerId/);
  expect(parseOrder({ ...order, amountCents: 1.5 })).toMatch(/amountCents/);
  expect(parseOrder({ ...order, amountCents: 0 })).toMatch(/amountCents/);
});

test('a new order is stored once and counted as created, with the cold start', async () => {
  ddb.on(PutCommand).resolves({});
  await expect(handler({ action: 'create', order }, ctx)).resolves.toEqual({ statusCode: 201, body: { orderId: 'ord-1' } });
  const put = ddb.commandCalls(PutCommand)[0]!.args[0].input;
  expect(put.ConditionExpression).toBe('attribute_not_exists(orderId)');
  expect(outcome()).toEqual(['created']);
  expect(metrics().filter((m) => 'ColdStart' in m)).toHaveLength(1);
  expect(metrics().find((m) => 'StoreLatency' in m)).toMatchObject({ Operation: 'put', requestId: 'req-1' });
});

test('only the first invocation in an environment counts a cold start', async () => {
  ddb.on(PutCommand).resolves({});
  await handler({ action: 'create', order }, ctx);
  await handler({ action: 'create', order: { ...order, orderId: 'ord-2' } }, ctx);
  expect(metrics().filter((m) => 'ColdStart' in m)).toHaveLength(1);
});

test('a repeated orderId is a 409 and counted as duplicate', async () => {
  ddb.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));
  await expect(handler({ action: 'create', order }, ctx)).resolves.toMatchObject({ statusCode: 409 });
  expect(outcome()).toEqual(['duplicate']);
});

test('an invalid order is a 400, counted as rejected, and never reaches DynamoDB', async () => {
  await expect(handler({ action: 'create', order: { ...order, amountCents: -5 } }, ctx)).resolves.toMatchObject({ statusCode: 400 });
  expect(outcome()).toEqual(['rejected']);
  expect(ddb.calls()).toHaveLength(0);
});

test('a DynamoDB failure is thrown, so Lambda counts an error, and latency is still recorded', async () => {
  ddb.on(PutCommand).rejects(new Error('boom'));
  await expect(handler({ action: 'create', order }, ctx)).rejects.toThrow('boom');
  expect(outcome()).toEqual([]);
  expect(metrics().find((m) => 'StoreLatency' in m)).toMatchObject({ Operation: 'put' });
});

test('get returns the order or 404, and validates the id', async () => {
  ddb.on(GetCommand).resolvesOnce({ Item: order }).resolvesOnce({});
  await expect(handler({ action: 'get', orderId: 'ord-1' }, ctx)).resolves.toEqual({ statusCode: 200, body: order });
  await expect(handler({ action: 'get', orderId: 'ord-9' }, ctx)).resolves.toMatchObject({ statusCode: 404 });
  await expect(handler({ action: 'get', orderId: '../x' }, ctx)).resolves.toMatchObject({ statusCode: 400 });
});

test('an unknown action is a 400', async () => {
  await expect(handler({ action: 'delete' } as never, ctx)).resolves.toMatchObject({ statusCode: 400 });
});

test('a missing ORDERS_TABLE fails loudly', async () => {
  delete process.env.ORDERS_TABLE;
  await expect(handler({ action: 'get', orderId: 'ord-1' }, ctx)).rejects.toThrow(/ORDERS_TABLE/);
});

test('every metric line is valid EMF from the catalog', async () => {
  ddb.on(PutCommand).resolves({});
  await handler({ action: 'create', order }, ctx);
  expect(write).toHaveBeenCalled();
  for (const m of metrics()) {
    const aws = m._aws as { CloudWatchMetrics: { Namespace: string; Dimensions: string[][] }[] };
    expect(aws.CloudWatchMetrics[0]!.Namespace).toBe('InfraTales/Orders');
    for (const dim of aws.CloudWatchMetrics[0]!.Dimensions.flat()) expect(['Service', 'Outcome', 'Operation']).toContain(dim);
  }
});
