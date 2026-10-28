#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { DataStack } from '../lib/data-stack';

const app = new cdk.App();

// Account and region come from the credentials in use, so no account IDs live in the repo.
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// Stack ids double as the values for Harness's PLUGIN_AWSCDK_STACKS / Stack Path.
const data = new DataStack(app, 'DeployLedgerData', { env });
new ApiStack(app, 'DeployLedgerApi', {
  env,
  table: data.table,
  queue: data.queue,
  deadLetterQueue: data.deadLetterQueue,
});

cdk.Tags.of(app).add('project', 'deploy-ledger');
cdk.Tags.of(app).add('managed-by', 'harness-iacm');
