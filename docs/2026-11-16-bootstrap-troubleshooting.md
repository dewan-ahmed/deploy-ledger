# Harness IaCM CDK pipeline: troubleshooting log (2026-11-16)

Account `<ACCOUNT_ID>`, region `us-east-1`. Related: a SecEng ticket.
Final result: pipeline run `<run-id>` succeeded end to end.

## Summary

The pipeline's `cdk bootstrap` step failed with an org SCP explicit deny on `iam:AttachRolePolicy`.
The SCP was working as designed. We caused the failure, and nothing was needed from SecEng.
Fixing it exposed two more independent bugs, one in synth and one in deploy.

| # | Symptom | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | Bootstrap: explicit deny by the org SCP on `iam:AttachRolePolicy` | The Harness `IACMAwsCdkPlugin` ran only `cdk bootstrap --no-notices`. It dropped `commandOptions`, so `--cloudformation-execution-policies` never reached CDK. CDK defaulted to `AdministratorAccess` on the CFN exec role, which the SCP denies. | Bootstrapped once by hand from the SSO profile with `--cloudformation-execution-policies arn:aws:iam::<ACCOUNT_ID>:policy/DeployLedgerCfnExecutionPolicy`. Set pipeline variable `runBootstrap=false`. |
| 2 | Synth: esbuild not found | The Harness runner installs only `infra/` dependencies. Lambda bundling needs `app/node_modules` (esbuild). | Commit `443a57d`: `commandHooks.beforeBundling` runs `npm ci` in `app/` if `node_modules` is missing. |
| 3 | Deploy: `ssm:GetParameters` implicitly denied for the CFN exec role | The scoped execution policy allowed only `ssm:GetParameter`. CDK's bootstrap-version check uses the plural form. | Commit `73d58d6`: added `ssm:GetParameters`. Published as managed policy `DeployLedgerCfnExecutionPolicy` v2. |

## Timeline

1. Read the SecEng ticket. The request was for `harness-poc-iac-policy` on the SSO PowerUser role. SecEng had said the SCP only blocks attaching `AdministratorAccess` to the exec role, and asked for a retest.
2. Decision: investigate our side before going back to SecEng with questions.
3. Pulled the step logs. The plugin ran only `cdk bootstrap --no-notices`. The log said "Using default execution policy of AdministratorAccess". The failed `CDKToolkit` stack showed `CloudFormationExecutionPolicies=""`.
4. CloudTrail showed `AttachRolePolicy` of ReadOnlyAccess to the lookup role SUCCEEDED in the same run. So the SCP is conditional, not a blanket deny. The denied event's `requestParameters` were empty, so the policy ARN came from the CDK log.
5. Confirmed `DeployLedgerCfnExecutionPolicy` in AWS matched `infra/iam/customer_architects_cdkPolicy.json`. The workspace had no flag overrides. The Harness docs don't document passing flags to the bootstrap step. The step schema accepts `commandOptions` as an array, and the plugin ignored it.
6. The IAM simulator said the SSO role already allowed the IAM actions. The simulator ignores SCPs, so this was only supporting evidence.
7. Bootstrapped manually with the scoped policy flag. It succeeded, which proves the SCP permits a scoped customer-managed policy on the exec role.
8. Set `runBootstrap=false`. The Bootstrap stage is skipped on purpose.
9. Synth failed on esbuild. Fixed in `443a57d`.
10. Deploy failed on `ssm:GetParameters`. Fixed in `73d58d6`. The auto-mode classifier blocked my `create-policy-version` call, so the user applied it with `/tmp/apply-policy.sh`.
11. Pipeline succeeded.

## Evidence for the ticket

- SCP deny: principal `assumed-role/HarnessDeployLedgerRole/harness-iacm`, authorization ID (recorded privately), request ID (recorded privately).
- Failed stack `CDKToolkit` had empty `CloudFormationExecutionPolicies`.
- Manual bootstrap output: `Execution policies: arn:aws:iam::<ACCOUNT_ID>:policy/DeployLedgerCfnExecutionPolicy`, then "Environment aws://<ACCOUNT_ID>/us-east-1 bootstrapped".
- Successful pipeline run `<run-id>` under `HarnessDeployLedgerRole`.

## Commits

- `443a57d` Install app dependencies before bundling Lambdas
- `73d58d6` Allow ssm:GetParameters on the CDK bootstrap version parameter

## Open items

- **Close the SecEng ticket.** `harness-poc-iac-policy` is not needed. Post a final comment first (the user does this, no tool changes the ticket).
- **Harness plugin bug.** `IACMAwsCdkPlugin` ignores `commandOptions` for `bootstrap`. Worth reporting to Harness IaCM support. Until fixed, `runBootstrap` must stay `false`, and a new account or region needs a manual bootstrap.
- `scripts/cleanup.sh` is uncommitted. It is dry-run by default.
- Pre-existing and untouched: other OIDC providers, `customer_architects_cdkPolicy` (a different policy from ours), `harness-cdk-execution-policy`, and CDK toolkit stacks in other regions (one is in `UPDATE_ROLLBACK_FAILED`, not ours).
