# Cost

All prices are us-east-1, taken from the AWS Price List API on 2026-10-15 (offers AmazonCloudWatch 20261007115540, AWSXRay 20260911124622, AmazonSNS 20260915151944). The free allowances come from the same files and the CloudWatch pricing page. The article workspace's `sources/aws-facts.md` has each quote and link.

## Free each month, and the price after

| Item | Free | After that |
|---|---|---|
| Custom metrics (each name and dimension-value combination) | 10 | $0.30 per metric-month for the first 10,000, prorated by the hour |
| Alarm metrics, standard resolution | 10 | $0.10 per alarm metric |
| Composite alarms | none | $0.50 each |
| Log ingestion, Standard class | 5 GB | $0.50 per GB |
| Log ingestion, Infrequent Access class | (same 5 GB) | $0.25 per GB |
| Log storage | 5 GB-month | $0.03 per GB-month, billed on compressed size |
| Logs Insights data scanned | 5 GB | $0.005 per GB |
| Dashboards | 3, up to 50 metrics each | $3 per dashboard |
| API requests (not GetMetricData) | 1,000,000 | $0.01 per 1,000 |
| Live Tail | 1,800 minutes | $0.01 per minute |
| X-Ray traces recorded | 100,000 | $5.00 per million |
| SNS email notifications | 1,000 | $2.00 per 100,000 |

Metrics that AWS services send by default are free. That covers Lambda's Invocations, Errors, Throttles and Duration, and DynamoDB's throttle metrics, which is why six of this stack's seven alarms cost nothing extra to feed.

## Bytes per request

The estimate uses sizes the tests measure:

| Line | Bytes | Where the number comes from |
|---|---|---|
| One application line at INFO | 170 | 168 bytes for this app's message in the JSON shape the Lambda docs show |
| Lambda's start and report lines | 600 | 534 bytes for the examples in the Lambda telemetry docs, rounded up because real lines carry more fields |
| Two EMF lines | 600 | 296 and 305 bytes from the EMF writer |
| **Total** | **1,370** | |

Check your own with a CloudWatch Logs Insights query over a day of logs, `stats sum(strlen(@message)) / count(*)`, divided by requests. Logs Insights scans count toward the free 5 GB of scanned data.

## This app at three sizes

`npm run estimate` prints these:

| Requests a month | Log ingestion | X-Ray (upper bound) | Lambda requests | Total |
|---|---|---|---|---|
| 100,000 | 0.14 GB, free | 100,000 traces, free | free | $0.00 |
| 1,000,000 | 1.37 GB, free | up to $4.50 | free | up to $4.50 |
| 5,000,000, tracing off | 6.85 GB, $0.92 | off | $0.80 | $1.72 |

Three free allowances run out in this order:

1. **X-Ray, from about 100,000 requests.** Lambda traces 1 request per second plus 5% of the rest. Below an average of 1 request per second, that can be every request. A month has 2,592,000 seconds, so at 1 million requests spread across the month up to 1 million get traced. Bursty traffic gets fewer, so treat this as a ceiling.
2. **Lambda requests, at 1 million.** After that, $0.20 per million on arm64.
3. **Log ingestion, at about 3.6 million requests.** Setting the system log level to WARN drops the start and successful report lines and pushes this to about 6.5 million.

Metrics, alarms and the dashboard don't grow with traffic. They stay at $0 as long as the catalog and the alarm list stay inside the budget, and synth enforces that. The one exception is the opt-in composite alarm: it costs $0.50 a month and synth lets it through.

## Things that bill without warning

- **A log group without retention.** CloudWatch keeps logs forever by default. Storage is cheap per GB, but it only grows.
- **A per-request dimension.** Each unique dimension value is a new metric. CloudWatch prorates custom metrics by the hour and bills only the hours a metric gets data, so a `requestId` metric sent once costs 1/730 of a metric-month. At 1 million requests a month that's about 1,370 metric-months, or about $408 a month in metrics (`npm run estimate -- --customMetricSeries=1000000 --customMetricHoursPerMonth=1`). That is still far outside the free 10.
- **Composite alarms.** They're $0.50 each from the first one.
- **A metric-math alarm.** It bills one alarm metric for each metric it lists. An error-rate alarm over Errors and Invocations uses two of your ten.
- **Anomaly detection alarms.** Each one bills three alarm metrics: the metric and the two band edges.
