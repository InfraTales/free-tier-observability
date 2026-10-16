# Contributing

Thanks for helping. This repo shows how to spend the CloudWatch free tier on purpose, so every change has to keep the budget checks honest.

## Setup

You need Node.js 24 and npm. Docker is only needed for the integration tests.

```bash
npm ci
npm run check        # type check, lint, bundle, unit + infra tests, synth with cdk-nag
npm run estimate     # the monthly estimate for this app
```

To run the integration tests:

```bash
docker run -d --rm -p 8016:8000 amazon/dynamodb-local:3.3.2
AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8016 npm run test:int
```

## Layout

| Path | What's there |
|---|---|
| `app/src/metric-catalog.ts` | Every custom metric and every value its dimensions may take |
| `app/src/metrics.ts` | The EMF writer. It writes to stdout and refuses values outside the catalog |
| `app/src/orders.ts` | The example function |
| `app/src/estimate.ts` | The monthly estimate, with prices from the AWS Price List API |
| `infra/lib/free-tier-observability.ts` | The construct |
| `infra/lib/orders-stack.ts` | The example stack and its alarms |
| `test/unit`, `test/infra` | Tests that run with `npm test` |
| `test/int` | The real bundle against DynamoDB Local |

## What a change needs

- **A test that fails without it.** For a bug, write the failing test first.
- **New metrics go in the catalog**, with every dimension value listed. Request IDs, user IDs and order IDs belong in log fields.
- **New alarms go through `addAlarm`**, so the alarm-metric count stays right.
- **Prices from the AWS Price List API**, with the offer version in a comment.
- **A written reason for any cdk-nag acknowledgement**, scoped to the construct it's about.
- **Docs updated** when behaviour changes.

## Pull requests

Branch from `main`, keep each pull request to one change, and explain why in the description. CI must pass before merge.

Found a security problem? Don't open a public issue. [SECURITY.md](SECURITY.md) says where to send it.

---

Created by Rahul Ladumor / InfraTales
