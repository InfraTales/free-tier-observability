/**
 * A small orders function: create an order (once per orderId) or read one back.
 * It exists to give the observability construct something real to watch.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SERVICE } from './metric-catalog';
import { emitMetric } from './metrics';

export interface Order {
  orderId: string;
  customerId: string;
  amountCents: number;
}

export type OrdersEvent = { action: 'create'; order: unknown } | { action: 'get'; orderId: unknown };

export interface OrdersResult {
  statusCode: number;
  body: Record<string, unknown>;
}

export interface Context {
  awsRequestId: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseOrder(input: unknown): Order | string {
  if (typeof input !== 'object' || input === null) return 'order must be an object';
  const o = input as Record<string, unknown>;
  if (typeof o.orderId !== 'string' || !ID.test(o.orderId)) return 'orderId must be 1-64 letters, digits, _ or -';
  if (typeof o.customerId !== 'string' || !ID.test(o.customerId)) return 'customerId must be 1-64 letters, digits, _ or -';
  if (typeof o.amountCents !== 'number' || !Number.isInteger(o.amountCents) || o.amountCents < 1 || o.amountCents > 10_000_000) {
    return 'amountCents must be an integer from 1 to 10000000';
  }
  return { orderId: o.orderId, customerId: o.customerId, amountCents: o.amountCents };
}

// Shared across invocations in one environment: the client and the cold-start flag.
let client: DynamoDBDocumentClient | undefined;
let coldStart = true;

function db(): DynamoDBDocumentClient {
  // AWS_ENDPOINT_URL_DYNAMODB points the SDK at DynamoDB Local in tests. No code path for it here.
  client ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return client;
}

async function timed<T>(operation: 'put' | 'get', requestId: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    emitMetric('StoreLatency', Math.round(performance.now() - start), { Service: SERVICE, Operation: operation }, { requestId });
  }
}

export async function handler(event: OrdersEvent, context: Context): Promise<OrdersResult> {
  const requestId = context.awsRequestId;
  const table = requireEnv('ORDERS_TABLE');
  if (coldStart) {
    coldStart = false;
    emitMetric('ColdStart', 1, { Service: SERVICE }, { requestId });
  }
  // DEBUG lines are dropped by Lambda unless you lower the application log level. They cost nothing until then.
  console.debug({ msg: 'event received', action: event?.action });

  if (event?.action === 'create') {
    const order = parseOrder(event.order);
    if (typeof order === 'string') {
      emitMetric('Orders', 1, { Service: SERVICE, Outcome: 'rejected' }, { requestId });
      console.warn({ msg: 'order rejected', reason: order });
      return { statusCode: 400, body: { error: order } };
    }
    try {
      await timed('put', requestId, () =>
        db().send(
          new PutCommand({
            TableName: table,
            Item: { ...order, createdAt: new Date().toISOString() },
            ConditionExpression: 'attribute_not_exists(orderId)',
          }),
        ),
      );
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') {
        emitMetric('Orders', 1, { Service: SERVICE, Outcome: 'duplicate' }, { requestId, orderId: order.orderId });
        console.info({ msg: 'duplicate order', orderId: order.orderId });
        return { statusCode: 409, body: { error: 'order already exists', orderId: order.orderId } };
      }
      throw err;
    }
    // orderId goes in as a log field, never as a dimension: one metric per order would be one bill line per order.
    emitMetric('Orders', 1, { Service: SERVICE, Outcome: 'created' }, { requestId, orderId: order.orderId });
    console.info({ msg: 'order created', orderId: order.orderId });
    return { statusCode: 201, body: { orderId: order.orderId } };
  }

  if (event?.action === 'get') {
    if (typeof event.orderId !== 'string' || !ID.test(event.orderId)) {
      return { statusCode: 400, body: { error: 'orderId must be 1-64 letters, digits, _ or -' } };
    }
    const orderId = event.orderId;
    const out = await timed('get', requestId, () => db().send(new GetCommand({ TableName: table, Key: { orderId } })));
    if (!out.Item) return { statusCode: 404, body: { error: 'not found' } };
    return { statusCode: 200, body: out.Item };
  }

  return { statusCode: 400, body: { error: 'action must be create or get' } };
}

/** Test hook: forget the cached client and cold-start flag. */
export function resetForTests(): void {
  client = undefined;
  coldStart = true;
}
