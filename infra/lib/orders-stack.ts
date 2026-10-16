import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps, Validations } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import { METRICS, NAMESPACE, SERVICE } from '../../app/src/metric-catalog';
import { FreeTierObservability, type FreeTierObservabilityProps } from './free-tier-observability';

export const BUNDLE_DIR = path.join(__dirname, '..', '..', 'build', 'orders');
export const ORDERS_TIMEOUT = Duration.seconds(10);

export interface OrdersStackProps extends StackProps {
  readonly alarmEmail?: string;
  /** Override any observability setting, for experiments and tests. */
  readonly observability?: Partial<Omit<FreeTierObservabilityProps, 'catalog' | 'namespace' | 'serviceName'>>;
  /** Alarm when no order is created for 24 hours. Off by default, so an idle demo doesn't email you daily. */
  readonly heartbeat?: boolean;
}

export class OrdersStack extends Stack {
  readonly obs: FreeTierObservability;

  constructor(scope: Construct, id: string, props: OrdersStackProps = {}) {
    super(scope, id, props);

    // Provisioned 2 read and 2 write units: inside DynamoDB's always-free 25 of each.
    const table = new dynamodb.Table(this, 'Orders', {
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 2,
      writeCapacity: 2,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.obs = new FreeTierObservability(this, 'Obs', {
      serviceName: SERVICE,
      namespace: NAMESPACE,
      catalog: METRICS,
      alarmEmail: props.alarmEmail,
      ...props.observability,
    });

    const fn = this.obs.addFunction('OrdersFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(BUNDLE_DIR),
      memorySize: 256,
      timeout: ORDERS_TIMEOUT,
      environment: { ORDERS_TABLE: table.tableName, NODE_OPTIONS: '--enable-source-maps' },
    });
    table.grant(fn, 'dynamodb:PutItem', 'dynamodb:GetItem');

    // 3 alarm metrics: errors, throttles, p99 duration.
    this.obs.watchFunction(fn, ORDERS_TIMEOUT);

    // 2 alarm metrics: either kind of throttle on the table means the 2 units are too few.
    const throttle = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName,
        dimensionsMap: { TableName: table.tableName },
        statistic: 'Sum',
        period: Duration.minutes(5),
      });
    this.obs.addAlarm('TableReadThrottles', { metric: throttle('ReadThrottleEvents'), threshold: 1, description: 'Orders table refused reads. Raise read capacity (25 units are free).' });
    this.obs.addAlarm('TableWriteThrottles', { metric: throttle('WriteThrottleEvents'), threshold: 1, description: 'Orders table refused writes. Raise write capacity (25 units are free).' });

    // 2 alarm metrics from our own EMF metrics.
    const rejected = this.obs.customMetric('Orders', { Service: SERVICE, Outcome: 'rejected' }, 'Sum');
    this.obs.addAlarm('RejectedSpike', {
      metric: rejected,
      threshold: 20,
      description: '20 or more invalid orders in 5 minutes. A client is broken or someone is probing.',
    });
    const putP99 = this.obs.customMetric('StoreLatency', { Service: SERVICE, Operation: 'put' }, 'p99');
    this.obs.addAlarm('StoreSlow', {
      metric: putP99,
      threshold: 500,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      description: 'DynamoDB writes took over 500 ms at p99 for 15 minutes.',
    });

    // Optional: 1 alarm metric. Missing data counts as breaching, so silence alarms too.
    const created = this.obs.customMetric('Orders', { Service: SERVICE, Outcome: 'created' }, 'Sum', Duration.hours(1));
    if (props.heartbeat) {
      this.obs.addAlarm('NoOrders', {
        metric: created,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 24,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        description: 'No order created in 24 hours.',
      });
    }

    this.obs.addGraphs(
      'Orders by outcome',
      (['created', 'duplicate', 'rejected'] as const).map((o) => this.obs.customMetric('Orders', { Service: SERVICE, Outcome: o }, 'Sum')),
      (['put', 'get'] as const).map((op) => this.obs.customMetric('StoreLatency', { Service: SERVICE, Operation: op }, 'p99')),
    );
    this.obs.addGraphs('Table throttles and cold starts', [
      throttle('ReadThrottleEvents'),
      throttle('WriteThrottleEvents'),
      this.obs.customMetric('ColdStart', { Service: SERVICE }, 'Sum'),
    ]);
    this.obs.finish();

    new CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'DashboardName', { value: this.obs.dashboard.dashboardName });
    new CfnOutput(this, 'AlarmTopicArn', { value: this.obs.topic.topicArn });

    // cdk-nag acknowledgements, each scoped to the construct it's about.
    Validations.of(table).acknowledge({
      id: 'AwsSolutions-DDB3',
      reason: 'Point-in-time recovery is billed per GB-month and has no free tier. Demo order data is disposable.',
    });
    Validations.of(this.obs.topic).acknowledge({
      id: 'AwsSolutions-SNS2',
      reason: 'Alarm notifications carry alarm names and states only. A customer managed KMS key costs $1 a month, and CloudWatch alarms cannot publish to a topic encrypted with the AWS managed SNS key.',
    });
  }
}
