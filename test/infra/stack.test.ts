import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { AwsSolutionsChecks } from 'cdk-nag';
import { HIGH_CARDINALITY_NAMES, METRICS, NAMESPACE } from '../../app/src/metric-catalog';
import { FREE_ALARM_METRICS, FREE_CUSTOM_METRICS, METRICS_PER_FREE_DASHBOARD } from '../../infra/lib/free-tier-observability';
import { OrdersStack, type OrdersStackProps } from '../../infra/lib/orders-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const build = (props: OrdersStackProps = {}) => {
  const stack = new OrdersStack(new cdk.App(), 'Test', { env, alarmEmail: 'ops@example.com', ...props });
  return { stack, template: Template.fromStack(stack) };
};
const { stack, template } = build();
const resources = (t: Template, type: string) => Object.values<any>(t.findResources(type));

/** Alarm metrics CloudWatch bills for one AWS::CloudWatch::Alarm: one per metric it lists. */
function billedMetrics(alarm: any): number {
  const p = alarm.Properties;
  if (p.MetricName) return 1;
  return (p.Metrics as any[]).filter((m) => m.MetricStat).length;
}

/** Every metric reference in the template: alarms and dashboard widgets. */
function metricRefs(t: Template): { namespace: string; name: string; dims: Record<string, unknown> }[] {
  const refs: { namespace: string; name: string; dims: Record<string, unknown> }[] = [];
  for (const a of resources(t, 'AWS::CloudWatch::Alarm')) {
    const p = a.Properties;
    if (p.MetricName) {
      refs.push({ namespace: p.Namespace, name: p.MetricName, dims: Object.fromEntries((p.Dimensions ?? []).map((d: any) => [d.Name, d.Value])) });
    }
    for (const m of p.Metrics ?? []) {
      if (!m.MetricStat) continue;
      const s = m.MetricStat.Metric;
      refs.push({ namespace: s.Namespace, name: s.MetricName, dims: Object.fromEntries((s.Dimensions ?? []).map((d: any) => [d.Name, d.Value])) });
    }
  }
  for (const body of dashboardBodies(t)) {
    for (const w of body.widgets) {
      for (const row of w.properties.metrics ?? []) {
        // Rows look like [namespace, name, dim1, val1, dim2, val2, ..., { options }]
        const parts = row.filter((x: unknown) => typeof x !== 'object' || x === null || Array.isArray(x) || 'Ref' in (x));
        const [namespace, name, ...rest] = parts;
        const dims: Record<string, unknown> = {};
        for (let i = 0; i + 1 < rest.length; i += 2) dims[rest[i]] = rest[i + 1];
        refs.push({ namespace, name, dims });
      }
    }
  }
  return refs;
}

/** Dashboard bodies with CloudFormation tokens replaced by placeholders, parsed as JSON. */
function dashboardBodies(t: Template): any[] {
  return resources(t, 'AWS::CloudWatch::Dashboard').map((d) => {
    const body = d.Properties.DashboardBody;
    const text = typeof body === 'string' ? body : body['Fn::Join'][1].map((p: unknown) => (typeof p === 'string' ? p : 'TOKEN')).join('');
    return JSON.parse(text);
  });
}

describe('free-tier budget', () => {
  test(`at most ${FREE_ALARM_METRICS} alarm metrics, counted the way CloudWatch bills them`, () => {
    const alarms = resources(template, 'AWS::CloudWatch::Alarm');
    expect(alarms.length).toBeGreaterThan(0);
    const used = alarms.reduce((n, a) => n + billedMetrics(a), 0);
    expect(used).toBe(7);
    expect(used).toBeLessThanOrEqual(FREE_ALARM_METRICS);
    expect(stack.obs.alarmMetricsUsed).toBe(used);
  });

  test('every alarm is standard resolution', () => {
    for (const a of resources(template, 'AWS::CloudWatch::Alarm')) expect(a.Properties.Period ?? 300).toBeGreaterThanOrEqual(60);
  });

  test('no composite alarm by default: they cost $0.50 each with no free tier', () => {
    expect(resources(template, 'AWS::CloudWatch::CompositeAlarm')).toHaveLength(0);
  });

  test(`custom metrics stay within ${FREE_CUSTOM_METRICS} series by construction`, () => {
    expect(stack.obs.customMetricSeries).toBeLessThanOrEqual(FREE_CUSTOM_METRICS);
    // Every custom metric the stack references is in the catalog, with catalog values only.
    const custom = metricRefs(template).filter((r) => r.namespace === NAMESPACE);
    expect(custom.length).toBeGreaterThan(0);
    for (const r of custom) {
      const spec = (METRICS as Record<string, { dimensions: Record<string, readonly string[]> }>)[r.name];
      expect(spec).toBeDefined();
      expect(Object.keys(r.dims).sort()).toEqual(Object.keys(spec!.dimensions).sort());
      for (const [k, v] of Object.entries(r.dims)) expect(spec!.dimensions[k]).toContain(v);
    }
  });

  test('no metric in an alarm or on the dashboard uses a high-cardinality dimension', () => {
    for (const r of metricRefs(template)) {
      for (const dim of Object.keys(r.dims)) expect(HIGH_CARDINALITY_NAMES).not.toContain(dim.toLowerCase());
    }
  });

  test(`one dashboard, with at most ${METRICS_PER_FREE_DASHBOARD} metrics, showing every alarm`, () => {
    expect(resources(template, 'AWS::CloudWatch::Dashboard')).toHaveLength(1);
    const [body] = dashboardBodies(template);
    const metrics = body.widgets.reduce((n: number, w: any) => n + (w.properties.metrics?.length ?? 0), 0);
    expect(metrics).toBeLessThanOrEqual(METRICS_PER_FREE_DASHBOARD);
    const status = body.widgets.find((w: any) => w.type === 'alarm');
    expect(status.properties.alarms).toHaveLength(resources(template, 'AWS::CloudWatch::Alarm').length);
  });
});

describe('logs', () => {
  test('every log group has a retention period and the Standard class', () => {
    const groups = resources(template, 'AWS::Logs::LogGroup');
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.Properties.RetentionInDays).toBe(14);
      expect(g.Properties.LogGroupClass).toBe('STANDARD');
    }
  });

  test('every function writes JSON logs at INFO to a log group the stack owns', () => {
    const groups = Object.keys(template.findResources('AWS::Logs::LogGroup'));
    const fns = resources(template, 'AWS::Lambda::Function');
    expect(fns.length).toBeGreaterThan(0);
    for (const fn of fns) {
      expect(fn.Properties.LoggingConfig).toEqual({
        LogFormat: 'JSON',
        ApplicationLogLevel: 'INFO',
        SystemLogLevel: 'INFO',
        LogGroup: { Ref: expect.any(String) },
      });
      expect(groups).toContain(fn.Properties.LoggingConfig.LogGroup.Ref);
    }
  });

  test('no LogRetention custom resource, whose own Lambda log group would keep logs forever', () => {
    expect(Object.keys(template.toJSON().Resources).filter((k) => template.toJSON().Resources[k].Type === 'Custom::LogRetention')).toEqual([]);
  });

  test('the function role writes only to its own log group', () => {
    const statements = resources(template, 'AWS::IAM::Policy').flatMap((p) => p.Properties.PolicyDocument.Statement);
    const logs = statements.filter((s: any) => [s.Action].flat().some((a: string) => a.startsWith('logs:')));
    expect(logs).toHaveLength(1);
    expect(logs[0].Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^ObsOrdersFnLogs/), 'Arn'] });
    expect(resources(template, 'AWS::IAM::Role').every((r) => !r.Properties.ManagedPolicyArns)).toBe(true);
  });

  test('the role may read and write orders, nothing else on DynamoDB', () => {
    const statements = resources(template, 'AWS::IAM::Policy').flatMap((p) => p.Properties.PolicyDocument.Statement);
    const ddb = statements.filter((s: any) => [s.Action].flat().some((a: string) => a.startsWith('dynamodb:')));
    expect(ddb.flatMap((s: any) => [s.Action].flat()).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem']);
  });
});

describe('traces and alarms', () => {
  test('X-Ray active tracing is on, and can be turned off', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { TracingConfig: { Mode: 'Active' } });
    const off = build({ observability: { tracing: false } }).template;
    for (const fn of resources(off, 'AWS::Lambda::Function')) expect(fn.Properties.TracingConfig).toBeUndefined();
    const xray = resources(off, 'AWS::IAM::Policy').flatMap((p) => p.Properties.PolicyDocument.Statement).filter((s: any) => JSON.stringify(s.Action).includes('xray:'));
    expect(xray).toEqual([]);
  });

  test('each alarm notifies the topic on ALARM and OK, and the topic emails', () => {
    for (const a of resources(template, 'AWS::CloudWatch::Alarm')) {
      expect(a.Properties.AlarmActions).toEqual([{ Ref: expect.stringMatching(/^ObsAlarms/) }]);
      expect(a.Properties.OKActions).toEqual(a.Properties.AlarmActions);
    }
    template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
  });

  test('CloudWatch alarms in this account may publish to the topic, and only over TLS', () => {
    const [policy] = resources(template, 'AWS::SNS::TopicPolicy');
    const statements = policy.Properties.PolicyDocument.Statement;
    const allow = statements.find((s: any) => s.Effect === 'Allow');
    expect(allow).toMatchObject({
      Principal: { Service: 'cloudwatch.amazonaws.com' },
      Action: 'sns:Publish',
      Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' } },
    });
    expect(JSON.stringify(allow.Condition.ArnLike['aws:SourceArn'])).toContain(':cloudwatch:us-east-1:123456789012:alarm:*');
    expect(statements.find((s: any) => s.Effect === 'Deny')).toMatchObject({ Condition: { Bool: { 'aws:SecureTransport': 'false' } } });
  });

  test('the slow alarm sits at 80% of the timeout', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Duration', ExtendedStatistic: 'p99', Threshold: 8000 });
  });

  test('composite mode: one composite alarm notifies, the others stay quiet', () => {
    const t = build({ observability: { compositeAlarm: true } }).template;
    const [composite, ...rest] = resources(t, 'AWS::CloudWatch::CompositeAlarm');
    expect(rest).toHaveLength(0);
    expect(composite.Properties.AlarmActions).toHaveLength(1);
    for (const a of resources(t, 'AWS::CloudWatch::Alarm')) expect(a.Properties.AlarmActions).toBeUndefined();
    const rule = JSON.stringify(composite.Properties.AlarmRule);
    expect(rule.match(/ALARM\(/g)).toHaveLength(resources(t, 'AWS::CloudWatch::Alarm').length);
  });

  test('the heartbeat alarm adds one alarm metric and treats silence as breaching', () => {
    const t = build({ heartbeat: true }).template;
    expect(resources(t, 'AWS::CloudWatch::Alarm')).toHaveLength(8);
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Orders', TreatMissingData: 'breaching', EvaluationPeriods: 24 });
  });
});

describe('guards that fail synth', () => {
  test('an 11th alarm metric fails synth', () => {
    const app = new cdk.App();
    const s = new OrdersStack(app, 'Over', { env, heartbeat: true });
    const fn = s.obs.functions[0]!;
    // 8 alarm metrics now; a math expression over 3 metrics bills 3 more.
    s.obs.addAlarm('ErrorRate', {
      metric: new cloudwatch.MathExpression({
        expression: '100 * e / (i + t)',
        usingMetrics: { e: fn.metricErrors(), i: fn.metricInvocations(), t: fn.metricThrottles() },
      }),
      threshold: 5,
      description: 'error rate',
    });
    expect(s.obs.alarmMetricsUsed).toBe(11);
    expect(() => app.synth()).toThrow(/11 alarm metrics; the free tier covers 10/);
  });

  test('a metric outside the catalog is refused', () => {
    const s = new OrdersStack(new cdk.App(), 'Bad', { env });
    expect(() => s.obs.customMetric('Orders', { Service: 'orders', Outcome: 'refunded' }, 'Sum')).toThrow(/not in the catalog/);
    expect(() => s.obs.customMetric('Orders', { Service: 'orders', Outcome: 'created', requestId: 'x' }, 'Sum')).toThrow(/exactly these dimensions/);
    expect(() => s.obs.customMetric('Revenue', { Service: 'orders' }, 'Sum')).toThrow(/not in the metric catalog/);
  });

  test('application log level WARN fails synth, because it drops EMF lines', () => {
    const app = new cdk.App();
    new OrdersStack(app, 'Quiet', { env, observability: { applicationLogLevel: lambda.ApplicationLogLevel.WARN } });
    expect(() => app.synth()).toThrow(/drops EMF lines/);
  });

  test('system log level WARN is allowed: it only drops START and successful REPORT lines', () => {
    const t = build({ observability: { systemLogLevel: lambda.SystemLogLevel.WARN } }).template;
    t.hasResourceProperties('AWS::Lambda::Function', { LoggingConfig: { SystemLogLevel: 'WARN', ApplicationLogLevel: 'INFO', LogFormat: 'JSON', LogGroup: Match.anyValue() } });
  });
});

test('cdk-nag AWS Solutions finds nothing unacknowledged', () => {
  const app = new cdk.App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-')) });
  new OrdersStack(app, 'Nag', { env, alarmEmail: 'ops@example.com' });
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const assembly = app.synth();
  const report = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'validation-report.json'), 'utf8'));
  expect(report.pluginReports.length).toBeGreaterThan(0);
  for (const plugin of report.pluginReports) expect(plugin.violations).toEqual([]);
});
