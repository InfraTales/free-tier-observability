#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { OrdersStack } from '../lib/orders-stack';

const app = new cdk.App();

// Optional: cdk deploy -c alertEmail=you@example.com -c heartbeat=true -c composite=true
const alertEmail: unknown = app.node.tryGetContext('alertEmail');
if (alertEmail !== undefined && (typeof alertEmail !== 'string' || !alertEmail.includes('@'))) {
  throw new Error(`alertEmail must be an email address, got ${JSON.stringify(alertEmail)}`);
}
const flag = (name: string) => String(app.node.tryGetContext(name)) === 'true';

new OrdersStack(app, 'FreeTierObservability', {
  alarmEmail: alertEmail,
  heartbeat: flag('heartbeat'),
  observability: { compositeAlarm: flag('composite') },
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

// Fail synth on any AWS Solutions finding that isn't acknowledged with a reason.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
