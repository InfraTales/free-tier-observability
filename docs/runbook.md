# Runbook

Every alarm emails the SNS topic when it goes into ALARM and again when it returns to OK. The dashboard named `orders` shows all of them in its top row.

To read the function's logs, open its log group in CloudWatch Logs Insights. The logs are JSON, so you can filter on fields:

```
fields @timestamp, level, message.msg, message.orderId, requestId
| filter level in ["WARN", "ERROR"]
| sort @timestamp desc
| limit 50
```

## orders-OrdersFnErrors

The function threw at least once in 5 minutes. Lambda counts a thrown error, a timeout and an out-of-memory crash the same way.

1. Run the query above for the alarm window. A thrown error has `errorType` and `stackTrace` fields.
2. If there's no ERROR line, look for a timeout or memory message in Lambda's report lines.
3. A DynamoDB failure also shows up as a StoreLatency spike on the dashboard.

## orders-OrdersFnThrottles

Lambda refused requests because the account or function ran out of concurrency. Check the account's concurrent executions on the Lambda console. If another function is using it all, give this one reserved concurrency.

## orders-OrdersFnSlowP99

The slowest 1% of requests took more than 8 seconds, 80% of the 10-second timeout, in 2 of the last 3 five-minute periods. Compare with StoreLatency. If DynamoDB is slow too, look at the table throttle alarms. If not, look at cold starts on the dashboard and at the X-Ray traces for that window.

## orders-TableReadThrottles and orders-TableWriteThrottles

The table refused requests over its provisioned capacity (2 reads and 2 writes a second). DynamoDB's always-free tier covers 25 of each, so raising them to fit the load is free up to that point. Change `readCapacity` or `writeCapacity` in `infra/lib/orders-stack.ts` and deploy.

## orders-RejectedSpike

The function rejected 20 or more invalid orders in 5 minutes. Run the query above with `filter message.msg = "order rejected"` and group by `message.reason`. One reason from one caller points to a broken client.

## orders-StoreSlow

DynamoDB writes took over 500 ms at p99 for 15 minutes. Check the AWS Health Dashboard for DynamoDB in the Region, then the table's throttle metrics.

## orders-NoOrders (only with `-c heartbeat=true`)

The function created no order in 24 hours. Missing data counts as breaching, so this alarm also fires if the function stops publishing metrics. If orders are arriving but the metric is missing, check that the application log level is still INFO or lower.

## orders-unhealthy (only with `-c composite=true`)

One or more of the alarms above is in ALARM. In this mode the individual alarms send nothing, so open the dashboard to see which one fired.
