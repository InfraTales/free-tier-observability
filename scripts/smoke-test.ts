/**
 * Checks against a deployed stack. Needs AWS credentials.
 *
 *   npm run smoke
 *
 * It invokes the function three ways (created, duplicate, rejected), then waits for the EMF
 * metrics to appear and checks the stack never created more than 10 custom metric series.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { NAMESPACE } from '../app/src/metric-catalog';

const STACK = process.env.STACK_NAME ?? 'FreeTierObservability';

async function output(name: string): Promise<string> {
  const out = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: STACK }));
  const value = out.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === name)?.OutputValue;
  if (!value) throw new Error(`stack ${STACK} has no ${name} output`);
  return value;
}

async function invoke(fn: string, payload: unknown): Promise<number> {
  const res = await new LambdaClient({}).send(new InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify(payload)) }));
  if (res.FunctionError) throw new Error(`function error: ${Buffer.from(res.Payload ?? []).toString()}`);
  return (JSON.parse(Buffer.from(res.Payload ?? []).toString()) as { statusCode: number }).statusCode;
}

async function main(): Promise<void> {
  const fn = await output('FunctionName');
  const order = { orderId: `smoke-${Date.now()}`, customerId: 'smoke', amountCents: 100 };
  const codes = [
    await invoke(fn, { action: 'create', order }),
    await invoke(fn, { action: 'create', order }),
    await invoke(fn, { action: 'create', order: { ...order, amountCents: -1 } }),
  ];
  if (codes.join() !== '201,409,400') throw new Error(`expected 201,409,400 and got ${codes.join()}`);
  console.log('invocations: 201, 409, 400 as expected');

  // EMF metrics show up a few minutes after the log lines arrive.
  const cw = new CloudWatchClient({});
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const metrics = (await cw.send(new ListMetricsCommand({ Namespace: NAMESPACE }))).Metrics ?? [];
    if (metrics.length > 10) throw new Error(`${metrics.length} custom metric series in ${NAMESPACE}; the free tier covers 10`);
    const outcomes = metrics.filter((m) => m.MetricName === 'Orders').map((m) => m.Dimensions?.find((d) => d.Name === 'Outcome')?.Value);
    if (['created', 'duplicate', 'rejected'].every((o) => outcomes.includes(o))) {
      console.log(`EMF metrics extracted: ${metrics.length} series in ${NAMESPACE}`);
      return;
    }
    if (Date.now() > deadline) throw new Error('EMF metrics did not appear within 10 minutes');
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
