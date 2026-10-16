/**
 * FreeTierObservability: logs, metrics, alarms, one dashboard and traces for a Lambda app,
 * sized to the CloudWatch always-free tier.
 *
 * - Every function gets its own log group with a retention period, JSON logs and log levels.
 * - Custom metrics come from a catalog that lists every dimension value, so the metric count
 *   is known at synth time.
 * - Alarms are counted by alarm metric, the unit CloudWatch bills. Synth fails over budget,
 *   and on high-resolution or Metrics Insights alarms, which the free tier doesn't cover.
 */
import { ArnFormat, Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { catalogProblems, type MetricCatalog, seriesCount } from '../../app/src/metric-catalog';

export const FREE_ALARM_METRICS = 10;
export const FREE_CUSTOM_METRICS = 10;
export const FREE_DASHBOARDS = 3;
/** One free dashboard may reference up to 50 metrics. */
export const METRICS_PER_FREE_DASHBOARD = 50;

export interface FreeTierObservabilityProps {
  /** Short name used in alarm and dashboard names. Letters, digits and dashes. */
  readonly serviceName: string;
  /** Custom metrics the app publishes with EMF. */
  readonly namespace: string;
  readonly catalog: MetricCatalog;
  /** Email for alarm notifications. AWS sends a confirmation link first. */
  readonly alarmEmail?: string;
  /** @default TWO_WEEKS */
  readonly logRetention?: logs.RetentionDays;
  /** @default INFO. WARN or higher drops EMF lines, so it's refused while the catalog is in use. */
  readonly applicationLogLevel?: lambda.ApplicationLogLevel;
  /** @default INFO. WARN drops the START and successful REPORT lines Lambda writes per request. */
  readonly systemLogLevel?: lambda.SystemLogLevel;
  /** X-Ray active tracing. Lambda samples 1 request per second plus 5% of the rest. @default true */
  readonly tracing?: boolean;
  /**
   * One composite alarm over all the others, so an incident sends one email instead of several.
   * Composite alarms cost $0.50 a month each and have no free tier. @default false
   */
  readonly compositeAlarm?: boolean;
}

export interface AlarmOptions {
  readonly metric: cloudwatch.IMetric;
  readonly threshold: number;
  readonly comparisonOperator?: cloudwatch.ComparisonOperator;
  readonly evaluationPeriods?: number;
  readonly datapointsToAlarm?: number;
  readonly treatMissingData?: cloudwatch.TreatMissingData;
  readonly description: string;
}

const LEVEL_ORDER = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

/** Alarm metrics CloudWatch bills for one metric or math expression. */
export function alarmMetricCount(metric: cloudwatch.IMetric): number {
  if (metric instanceof cloudwatch.MathExpression) {
    return Object.values(metric.usingMetrics).reduce((n, m) => n + alarmMetricCount(m), 0);
  }
  return 1;
}

/**
 * Why an alarm on this metric falls outside the free tier, or undefined if it doesn't. The free
 * alarm metrics only cover standard-resolution alarms that list their metrics directly.
 * - A Metrics Insights query (SELECT ...) bills per metric it analyzes, which synth can't count.
 * - A period under 60 seconds makes it a high-resolution alarm, billed at a higher rate.
 */
export function paidAlarmReason(metric: cloudwatch.IMetric): string | undefined {
  const config = metric.toMetricConfig();
  if (config.mathExpression) {
    if (/\bSELECT\b/i.test(config.mathExpression.expression)) {
      return 'uses a Metrics Insights query, which bills per metric analyzed and has no free tier';
    }
    // CDK applies the expression's period to every metric in it, so this one number decides.
    const seconds = config.mathExpression.period;
    return seconds < 60 ? `has a ${seconds}-second period, so it's a high-resolution alarm` : undefined;
  }
  const seconds = config.metricStat?.period.toSeconds() ?? 60;
  return seconds < 60 ? `has a ${seconds}-second period, so it's a high-resolution alarm` : undefined;
}

export class FreeTierObservability extends Construct {
  readonly topic: sns.Topic;
  readonly dashboard: cloudwatch.Dashboard;
  readonly alarms: cloudwatch.Alarm[] = [];
  readonly functions: lambda.Function[] = [];
  readonly logGroups: logs.LogGroup[] = [];
  composite?: cloudwatch.CompositeAlarm;

  private readonly props: FreeTierObservabilityProps;
  private readonly alarmAction: cwActions.SnsAction;
  private readonly alarmStatus: cloudwatch.IAlarm[] = [];
  private dashboardMetrics = 0;

  constructor(scope: Construct, id: string, props: FreeTierObservabilityProps) {
    super(scope, id);
    if (!/^[A-Za-z0-9-]{1,40}$/.test(props.serviceName)) throw new Error('serviceName must be 1-40 letters, digits or dashes');
    this.props = props;

    // Alarm messages hold alarm names and states only. An AWS KMS customer managed key would
    // cost $1 a month, and the AWS managed SNS key can't be used by CloudWatch alarms.
    this.topic = new sns.Topic(this, 'Alarms', { displayName: `${props.serviceName} alarms`, enforceSSL: true });
    // enforceSSL gives the topic a resource policy, which replaces the default one. CloudWatch
    // alarms then need an explicit allow, or every alarm action fails with "not authorized".
    const stack = Stack.of(this);
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToPublish',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': stack.formatArn({ service: 'cloudwatch', resource: 'alarm', resourceName: '*', arnFormat: ArnFormat.COLON_RESOURCE_NAME }) },
        },
      }),
    );
    if (props.alarmEmail) this.topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    this.alarmAction = new cwActions.SnsAction(this.topic);

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: props.serviceName,
      defaultInterval: Duration.days(1),
    });
    // The array fills in as alarms are added; CDK renders the dashboard body at synth.
    this.dashboard.addWidgets(new cloudwatch.AlarmStatusWidget({ title: 'Alarms', alarms: this.alarmStatus, width: 24 }));

    this.node.addValidation({ validate: () => this.budgetProblems() });
  }

  get alarmMetricsUsed(): number {
    return this.alarms.reduce((n, a) => n + alarmMetricCount(a.metric), 0);
  }

  get customMetricSeries(): number {
    return seriesCount(this.props.catalog);
  }

  /** Everything that would push this stack past the free tier or break EMF. */
  budgetProblems(): string[] {
    const problems = catalogProblems(this.props.catalog);
    for (const alarm of this.alarms) {
      const reason = paidAlarmReason(alarm.metric);
      if (reason) problems.push(`alarm ${alarm.node.id} ${reason}; the free tier covers standard-resolution alarms only`);
    }
    if (this.alarmMetricsUsed > FREE_ALARM_METRICS) {
      problems.push(`${this.alarmMetricsUsed} alarm metrics; the free tier covers ${FREE_ALARM_METRICS}`);
    }
    if (this.customMetricSeries > FREE_CUSTOM_METRICS) {
      problems.push(`${this.customMetricSeries} custom metric series; the free tier covers ${FREE_CUSTOM_METRICS}`);
    }
    if (this.dashboardMetrics > METRICS_PER_FREE_DASHBOARD) {
      problems.push(`dashboard references ${this.dashboardMetrics} metrics; a free dashboard holds ${METRICS_PER_FREE_DASHBOARD}`);
    }
    const level = this.props.applicationLogLevel ?? lambda.ApplicationLogLevel.INFO;
    if (Object.keys(this.props.catalog).length > 0 && LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf('INFO')) {
      problems.push(`application log level ${level} drops EMF lines (Lambda treats them as INFO); use INFO or lower`);
    }
    return problems;
  }

  /**
   * Create a Lambda function with logging set up for the free tier. The log group is created
   * here, so it exists before the first invoke and has a retention period from day one.
   */
  addFunction(
    id: string,
    props: Omit<lambda.FunctionProps, 'logGroup' | 'logRetention' | 'role' | 'loggingFormat' | 'applicationLogLevelV2' | 'systemLogLevelV2' | 'tracing'>,
  ): lambda.Function {
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      retention: this.props.logRetention ?? logs.RetentionDays.TWO_WEEKS,
      // EMF, metric filters and Live Tail need the Standard class. A group's class can't change later.
      logGroupClass: logs.LogGroupClass.STANDARD,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // Our own role instead of AWSLambdaBasicExecutionRole, which allows writing to any log group.
    const role = new iam.Role(this, `${id}Role`, { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    role.addToPolicy(
      new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logGroup.logGroupArn] }),
    );
    const tracing = this.props.tracing !== false;
    const fn = new lambda.Function(this, id, {
      architecture: lambda.Architecture.ARM_64,
      ...props,
      role,
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: this.props.applicationLogLevel ?? lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: this.props.systemLogLevel ?? lambda.SystemLogLevel.INFO,
      // PASS_THROUGH would still grant X-Ray write access in CDK; DISABLED leaves the role without it.
      tracing: tracing ? lambda.Tracing.ACTIVE : lambda.Tracing.DISABLED,
    });
    if (tracing) {
      Validations.of(role).acknowledge({
        id: 'AwsSolutions::AwsSolutions-IAM5[Resource::*]',
        reason: 'xray:PutTraceSegments and xray:PutTelemetryRecords do not support resource-level permissions, so X-Ray active tracing needs Resource "*".',
      });
    }
    this.functions.push(fn);
    this.logGroups.push(logGroup);
    return fn;
  }

  /** A standard-resolution alarm that notifies the topic (or feeds the composite alarm). */
  addAlarm(id: string, o: AlarmOptions): cloudwatch.Alarm {
    const alarm = new cloudwatch.Alarm(this, id, {
      alarmName: `${this.props.serviceName}-${id}`,
      alarmDescription: o.description,
      metric: o.metric,
      threshold: o.threshold,
      comparisonOperator: o.comparisonOperator ?? cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: o.evaluationPeriods ?? 1,
      datapointsToAlarm: o.datapointsToAlarm,
      treatMissingData: o.treatMissingData ?? cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    if (!this.props.compositeAlarm) {
      alarm.addAlarmAction(this.alarmAction);
      alarm.addOkAction(this.alarmAction);
    }
    this.alarms.push(alarm);
    this.alarmStatus.push(alarm);
    return alarm;
  }

  /** Errors, throttles and p99 duration: three alarm metrics, all from free Lambda metrics. */
  watchFunction(fn: lambda.Function, timeout: Duration): void {
    const name = fn.node.id;
    const fiveMin = { period: Duration.minutes(5) };
    this.addAlarm(`${name}Errors`, {
      metric: fn.metricErrors({ ...fiveMin, statistic: 'Sum' }),
      threshold: 1,
      description: `${name} threw at least one error in 5 minutes. Check its log group.`,
    });
    this.addAlarm(`${name}Throttles`, {
      metric: fn.metricThrottles({ ...fiveMin, statistic: 'Sum' }),
      threshold: 1,
      description: `Lambda refused at least one ${name} request for lack of concurrency.`,
    });
    this.addAlarm(`${name}SlowP99`, {
      metric: fn.metricDuration({ ...fiveMin, statistic: 'p99' }),
      threshold: Math.round(timeout.toMilliseconds() * 0.8),
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      description: `${name} p99 duration is above 80% of its timeout in 2 of the last 3 five-minute periods.`,
    });
    this.addGraphs(`${name}`, [
      fn.metricInvocations({ statistic: 'Sum' }),
      fn.metricErrors({ statistic: 'Sum' }),
      fn.metricThrottles({ statistic: 'Sum' }),
    ], [fn.metricDuration({ statistic: 'p50' }), fn.metricDuration({ statistic: 'p99' })]);
  }

  /** One metric from the catalog, checked against it, for alarms and graphs. */
  customMetric(name: string, dimensions: Record<string, string>, statistic: string, period = Duration.minutes(5)): cloudwatch.Metric {
    const spec = this.props.catalog[name];
    if (!spec) throw new Error(`${name} is not in the metric catalog`);
    const keys = Object.keys(spec.dimensions).sort();
    if (JSON.stringify(Object.keys(dimensions).sort()) !== JSON.stringify(keys)) {
      throw new Error(`${name} needs exactly these dimensions: ${keys.join(', ')}`);
    }
    for (const [k, v] of Object.entries(dimensions)) {
      if (!spec.dimensions[k]!.includes(v)) throw new Error(`${name}: ${k}=${v} is not in the catalog`);
    }
    return new cloudwatch.Metric({ namespace: this.props.namespace, metricName: name, dimensionsMap: dimensions, statistic, period });
  }

  /** A row with a count graph on the left and a latency (or any second) graph on the right. */
  addGraphs(title: string, left: cloudwatch.IMetric[], right: cloudwatch.IMetric[] = []): void {
    this.dashboardMetrics += left.length + right.length;
    const widgets: cloudwatch.IWidget[] = [new cloudwatch.GraphWidget({ title, left, width: right.length ? 12 : 24 })];
    if (right.length) widgets.push(new cloudwatch.GraphWidget({ title: `${title} latency`, left: right, width: 12 }));
    this.dashboard.addWidgets(...widgets);
  }

  /** Call once after the last addAlarm. Adds the composite alarm when it's turned on. */
  finish(): void {
    if (!this.props.compositeAlarm || this.composite) return;
    if (this.alarms.length === 0) throw new Error('add alarms before finish()');
    this.composite = new cloudwatch.CompositeAlarm(this, 'Unhealthy', {
      compositeAlarmName: `${this.props.serviceName}-unhealthy`,
      alarmDescription: `One or more ${this.props.serviceName} alarms are firing. The dashboard shows which.`,
      alarmRule: cloudwatch.AlarmRule.anyOf(...this.alarms.map((a) => cloudwatch.AlarmRule.fromAlarm(a, cloudwatch.AlarmState.ALARM))),
    });
    this.composite.addAlarmAction(this.alarmAction);
    this.composite.addOkAction(this.alarmAction);
    this.alarmStatus.push(this.composite);
  }
}
