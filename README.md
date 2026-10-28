# deploy-ledger

A small serverless service that records deployment events and rolls them up into
[DORA](https://dora.dev/) metrics. It is a monorepo: the application and the AWS CDK
infrastructure that deploys it live side by side, and the infrastructure is provisioned by
[Harness IaCM](https://developer.harness.io/docs/infra-as-code-management) using its native
**AWS CDK** workspace type.

```
app/      Lambda handlers (TypeScript) + unit tests
infra/    AWS CDK app (TypeScript): DeployLedgerData and DeployLedgerApi stacks
```

## What it does

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/events` | Record a deployment (`service`, `environment`, `version`, `status`, optional `deployedAt`, `commitTime`) |
| `GET` | `/events?service=<name>&limit=<n>` | List a service's deployments, newest first |
| `GET` | `/services/{id}/metrics` | Deployment frequency, change failure rate and median lead time over the last 30 days |

Every method requires an API key (`x-api-key` header).

```
client ──► API Gateway ──► createEvent ──► DynamoDB (events)
                              │
                              └──► SQS ──► aggregateMetrics ──► DynamoDB (METRICS item)
                                    └─(3 failed attempts)──► DLQ ──► CloudWatch alarm
```

`status` is `success`, `failure` or `rollback`. Failures and rollbacks both count toward the
change failure rate.

## Infrastructure

| Stack | Contents |
| --- | --- |
| `DeployLedgerData` | DynamoDB table (on-demand, point-in-time recovery), SQS queue, dead-letter queue |
| `DeployLedgerApi` | Four Lambda functions (Node.js 24, arm64), REST API with API key and usage plan, CloudWatch dashboard and four alarms |

The stack ids are what Harness's `PLUGIN_AWSCDK_STACKS` variable and the pipeline steps'
**Stack Path** field refer to. No account IDs or credentials are stored in this repository:
the CDK reads the target account and region from the credentials in use, and defaults to
`us-east-1`.

> The table uses `RemovalPolicy.DESTROY` so a demo tear-down leaves nothing behind. Change it to
> `RETAIN` before storing real audit data.

## Develop locally

Requires Node.js 22 or later.

```bash
# App
cd app
npm ci
npm test

# Infrastructure (the CDK app bundles the handlers from ../app)
cd ../infra
npm ci
npm test
npx cdk synth        # synthesizes both stacks to cdk.out/
```

Deploying outside Harness needs a bootstrapped account:
`npx cdk bootstrap` once, then `npx cdk deploy --all`.

## Deploying with Harness IaCM

1. Create an AWS connector (OIDC is recommended) for a role that can deploy CloudFormation stacks.
2. Create a Git connector for this repository.
3. Create an IaCM workspace of type **AWS CDK**: folder path `infra`, language TypeScript, and the
   workspace variable `PLUGIN_AWS_REGION=us-east-1`.
4. Run the pipeline: **Bootstrap** (once per account and region) → **Synth** → **Diff** →
   **IACM Approval** → **Deploy**.

## After deploying

```bash
# The stack outputs the API URL and the API key's id (not its value)
aws apigateway get-api-key --api-key <ApiKeyId> --include-value --query value --output text

curl -X POST "<ApiUrl>events" -H "x-api-key: <key>" -H "Content-Type: application/json" \
  -d '{"service":"checkout","environment":"production","version":"1.4.2","status":"success"}'

curl "<ApiUrl>services/checkout/metrics" -H "x-api-key: <key>"
```

Metrics appear a few seconds after the first event, once the aggregator has run.

## License

[MIT](LICENSE)
