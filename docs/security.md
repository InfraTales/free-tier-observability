# Security

## Permissions

The function has its own IAM role. We didn't use the AWS managed `AWSLambdaBasicExecutionRole`, because it lets a function write to any log group in the account. The role allows:

| Action | Resource |
|---|---|
| `logs:CreateLogStream`, `logs:PutLogEvents` | This function's log group only |
| `dynamodb:PutItem`, `dynamodb:GetItem` | The orders table only |
| `xray:PutTraceSegments`, `xray:PutTelemetryRecords` | `*`, because these actions don't support resource-level permissions |

With tracing off, the construct uses Lambda's `Disabled` tracing mode, and the role gets no X-Ray permissions. CDK's `PassThrough` mode would still add them.

EMF metrics need only `logs:PutLogEvents`. The function has no `cloudwatch:PutMetricData` permission.

## What goes into logs and metrics

- The `requestId` and `orderId` go into log lines as fields. No metric uses them as a dimension.
- The handler logs order IDs and rejection reasons, not the full event.
- Order IDs and customer IDs must match `^[A-Za-z0-9_-]{1,64}$`, so a crafted value can't break a log line or a Logs Insights query.

## Choices we made, and why

- **The SNS topic isn't encrypted with KMS.** A customer managed key costs $1 a month, and CloudWatch alarms can't publish to a topic encrypted with the AWS managed SNS key. Alarm emails carry alarm names and states only. The topic policy refuses requests that don't use TLS. Because that policy replaces SNS's default one, it also has an explicit allow for CloudWatch alarms from this account. Without it, every alarm action fails with "not authorized". If your alarm descriptions carry anything sensitive, add a customer managed key and let `cloudwatch.amazonaws.com` use it.
- **No point-in-time recovery on the table.** It has no free tier, and demo orders are disposable. Turn it on for real data.
- **The stack deletes its log group and table on `cdk destroy`.** That suits a demo. For real data, set `RemovalPolicy.RETAIN`.

cdk-nag (AWS Solutions) runs on every synth and in a test. Each acknowledged finding sits next to the resource it's about, with its reason.
