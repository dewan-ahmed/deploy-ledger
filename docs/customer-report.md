# deploy-ledger: what was built and how it is deployed

Account `<ACCOUNT_ID>`, region `us-east-1`. Everything is defined as code in this repo.
No secrets are recorded here. The API key value is not stored in the repo or in stack outputs.

## 1. What the application does

deploy-ledger records deployment events and serves DORA-style metrics per service. It is serverless.
`POST /events` stores a deployment event and queues it for aggregation. `GET /events` lists events. `GET /services/{id}/metrics` returns the aggregated metrics.

## 2. AWS resources

### Stack `DeployLedgerData` (state)

| Resource | Purpose |
|----------|---------|
| DynamoDB table (on-demand billing, point-in-time recovery on) | Events and aggregates |
| SQS queue `AggregationQueue` (SQS-managed encryption, TLS enforced, 60s visibility timeout) | Hand-off from the ingest API to the aggregator |
| SQS dead-letter queue (14-day retention, redrive after 3 receives) | Holds messages that repeatedly fail aggregation |

The table has removal policy DESTROY because this is a demo. For real audit data, change it to RETAIN.

### Stack `DeployLedgerApi` (compute and API)

| Resource | Purpose |
|----------|---------|
| 4 Lambda functions: CreateEvent, ListEvents, GetMetrics, AggregateMetrics (Node.js 24, arm64, 256 MB) | Handlers, bundled with esbuild |
| 4 CloudWatch log groups (1-week retention) | Function logs |
| SQS event source mapping (batch 10, partial batch failure reporting) | Triggers AggregateMetrics |
| API Gateway REST API `deploy-ledger`, stage `v1` (50 rps, burst 100) | Public API |
| API key and usage plan (25 rps, burst 50, 100,000 requests a month) | Every method requires the key |
| 4 CloudWatch alarms: DLQ not empty, CreateEvent errors, Aggregator errors, API 5XX | Alerting |
| CloudWatch dashboard `deploy-ledger` | Requests, latency, Lambda errors, queue depth |
| Per-function IAM execution roles | Least privilege via CDK grants (for example only CreateEvent can write and send) |

Outputs: `ApiUrl`, and `ApiKeyId`. Fetch the key value only when needed with
`aws apigateway get-api-key --api-key <ApiKeyId> --include-value`.

### CDK bootstrap (`CDKToolkit` stack, qualifier `hnb659fds`)

Standard CDK roles (deploy, lookup, file-publishing, image-publishing, CloudFormation execution), an assets S3 bucket, an ECR repository for container assets, and an SSM version parameter.
The CloudFormation execution role carries our scoped policy instead of `AdministratorAccess` (see section 4).

### IAM created by hand (in `infra/iam/`)

| Resource | Purpose |
|----------|---------|
| Role `HarnessDeployLedgerRole` | Assumed by Harness via OIDC. No stored AWS keys. |
| Inline policy `DeployLedgerHarness` on that role | What Harness may do (section 4) |
| Managed policy `DeployLedgerCfnExecutionPolicy` (v2) | What CloudFormation may do when it deploys the app |

## 3. Harness resources

| Resource | Detail |
|----------|--------|
| AWS connector `deployledger_aws` | OIDC-based, assumes `HarnessDeployLedgerRole` with session name `harness-iacm` |
| IaCM workspace `deployledger_cdk` | AWS CDK, points at `infra/` in this repo |
| Pipeline | Stages: Bootstrap, Synth, Diff, IACM Approval, Deploy. All use the `IACMAwsCdkPlugin` step. |
| Pipeline variable `runBootstrap` | Currently `false`, so Bootstrap is skipped (section 5) |

Flow: Harness gets short-lived credentials by OIDC, synthesizes the CDK app, shows a diff, waits for human approval, then deploys through the CDK roles.

## 4. Security design

1. **No long-lived credentials.** The trust policy accepts only the Harness account's OIDC issuer with audience `sts.amazonaws.com`.
2. **Harness role is narrow.** It can assume only `cdk-hnb659fds-*` roles. It can manage CloudFormation only on `CDKToolkit` and `DeployLedger*` stacks. It reaches S3, ECR and SSM only for the toolkit resources, and it manages IAM only on `role/cdk-hnb659fds-*`.
3. **CloudFormation executes with a scoped policy.** It covers `DeployLedger*` stacks, tables, queues, functions, log groups and roles. Roles it creates must be named `DeployLedger*`, and `iam:PassRole` is limited to Lambda and API Gateway.
4. **No privilege escalation.** An explicit Deny blocks attaching or putting `AdministratorAccess`.
5. **Org guardrail respected.** The organisation SCP blocks attaching `AdministratorAccess` to the exec role. We comply with it instead of asking for an exception.

## 5. Things the customer should know

- **Bootstrap is manual.** The Harness CDK plugin does not pass `commandOptions` for `bootstrap`, so the scoped execution policy cannot be supplied from the pipeline. We bootstrapped once from an SSO session and turned the stage off. A new account or region needs the same manual step:
  `cdk bootstrap --cloudformation-execution-policies arn:aws:iam::<ACCOUNT_ID>:policy/DeployLedgerCfnExecutionPolicy`.
  We recommend raising this with Harness IaCM support.
- **Lambda bundling installs `app/` dependencies** on the runner, which costs a little time on the first synth.
- **Demo defaults:** the table is DESTROY, and the API key quota is 100,000 requests a month.

## 6. Cleanup

`scripts/cleanup.sh` removes everything in layers (see its header). It does nothing without `--execute` and asks you to type the account ID. It never touches shared or unrelated resources.

```
scripts/cleanup.sh                                   # dry run, app stacks only
scripts/cleanup.sh --execute                         # delete DeployLedgerApi and DeployLedgerData
scripts/cleanup.sh --execute --toolkit --iam         # also bootstrap and execution policy
scripts/cleanup.sh --execute --harness-role          # last, ends Harness access
```

The Harness connector, workspace and pipeline are not removed by the script. Delete them in the Harness UI.
