import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../lib/api-stack';
import { DataStack } from '../lib/data-stack';

function build() {
  // Skip esbuild bundling so the tests are fast and need no installed handler dependencies.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const data = new DataStack(app, 'Data');
  const api = new ApiStack(app, 'Api', {
    table: data.table,
    queue: data.queue,
    deadLetterQueue: data.deadLetterQueue,
  });
  return { data: Template.fromStack(data), api: Template.fromStack(api) };
}

describe('DataStack', () => {
  const { data } = build();

  it('creates an on-demand table with point-in-time recovery', () => {
    data.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    });
  });

  it('routes failed messages to a dead-letter queue after three attempts', () => {
    data.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });
});

describe('ApiStack', () => {
  const { api } = build();

  it('creates four Node 24 arm64 Lambda functions', () => {
    api.resourceCountIs('AWS::Lambda::Function', 4);
    api.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs24.x', Architectures: ['arm64'] });
  });

  it('requires an API key on every method', () => {
    const methods = api.findResources('AWS::ApiGateway::Method');
    expect(Object.keys(methods)).toHaveLength(3);
    for (const method of Object.values(methods)) {
      expect(method.Properties.ApiKeyRequired).toBe(true);
    }
  });

  it('feeds the aggregator from the queue with partial batch responses', () => {
    api.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      BatchSize: 10,
    });
  });

  it('alarms on the dead-letter queue, Lambda errors and API 5XX', () => {
    api.resourceCountIs('AWS::CloudWatch::Alarm', 4);
  });

  it('exports the API URL and key id but not the key value', () => {
    // RestApi also adds its own "ApiEndpoint<hash>" output, so match on prefix.
    const names = Object.keys(api.findOutputs('*'));
    expect(names).toEqual(expect.arrayContaining(['ApiKeyId', 'ApiUrl']));
    expect(names.every((n) => n === 'ApiKeyId' || n === 'ApiUrl' || n.startsWith('ApiEndpoint'))).toBe(true);
  });
});
