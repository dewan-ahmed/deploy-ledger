import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface ApiStackProps extends cdk.StackProps {
  table: dynamodb.ITable;
  queue: sqs.IQueue;
  deadLetterQueue: sqs.IQueue;
}

// The app package owns its dependencies (and esbuild), so it is the bundling root.
const APP_DIR = path.resolve(__dirname, '../../app');
const HANDLERS_DIR = path.join(APP_DIR, 'src/handlers');

/** The public API, the Lambda handlers behind it, and the operational dashboard and alarms. */
export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { table, queue, deadLetterQueue } = props;

    const makeFunction = (name: string, handlerFile: string, environment: Record<string, string>, timeout = 10) =>
      new NodejsFunction(this, name, {
        entry: path.join(HANDLERS_DIR, handlerFile),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: cdk.Duration.seconds(timeout),
        environment,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        projectRoot: APP_DIR,
        depsLockFilePath: path.join(APP_DIR, 'package-lock.json'),
        bundling: { minify: true, sourceMap: true, target: 'node24' },
      });

    const createEvent = makeFunction('CreateEvent', 'createEvent.ts', {
      TABLE_NAME: table.tableName,
      QUEUE_URL: queue.queueUrl,
    });
    const listEvents = makeFunction('ListEvents', 'listEvents.ts', { TABLE_NAME: table.tableName });
    const getMetrics = makeFunction('GetMetrics', 'getMetrics.ts', { TABLE_NAME: table.tableName });
    const aggregateMetrics = makeFunction('AggregateMetrics', 'aggregateMetrics.ts', { TABLE_NAME: table.tableName }, 30);

    table.grantWriteData(createEvent);
    queue.grantSendMessages(createEvent);
    table.grantReadData(listEvents);
    table.grantReadData(getMetrics);
    table.grantReadWriteData(aggregateMetrics);
    aggregateMetrics.addEventSource(new SqsEventSource(queue, { batchSize: 10, reportBatchItemFailures: true }));

    // --- REST API (every method requires an API key) ---
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: 'deploy-ledger',
      description: 'Deployment audit trail and DORA metrics',
      deployOptions: {
        stageName: 'v1',
        metricsEnabled: true,
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
      },
    });

    const events = api.root.addResource('events');
    events.addMethod('POST', new apigw.LambdaIntegration(createEvent), { apiKeyRequired: true });
    events.addMethod('GET', new apigw.LambdaIntegration(listEvents), { apiKeyRequired: true });

    const metrics = api.root.addResource('services').addResource('{id}').addResource('metrics');
    metrics.addMethod('GET', new apigw.LambdaIntegration(getMetrics), { apiKeyRequired: true });

    const apiKey = api.addApiKey('DefaultKey');
    const usagePlan = api.addUsagePlan('DefaultPlan', {
      throttle: { rateLimit: 25, burstLimit: 50 },
      quota: { limit: 100_000, period: apigw.Period.MONTH },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });

    // --- Alarms ---
    const alarm = (name: string, metric: cloudwatch.IMetric, description: string) =>
      new cloudwatch.Alarm(this, name, {
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });

    const dlqDepth = deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) });
    alarm('DlqNotEmpty', dlqDepth, 'Metric aggregation messages are failing and landing in the DLQ');
    alarm('CreateEventErrors', createEvent.metricErrors({ period: cdk.Duration.minutes(5) }), 'POST /events Lambda errors');
    alarm('AggregatorErrors', aggregateMetrics.metricErrors({ period: cdk.Duration.minutes(5) }), 'Aggregator Lambda errors');
    alarm('Api5xx', api.metricServerError({ period: cdk.Duration.minutes(5) }), 'API Gateway 5XX responses');

    // --- Dashboard ---
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', { dashboardName: 'deploy-ledger' });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API requests and errors',
        left: [api.metricCount(), api.metricClientError(), api.metricServerError()],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'API latency',
        left: [api.metricLatency()],
        width: 12,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda errors',
        left: [createEvent, listEvents, getMetrics, aggregateMetrics].map((fn) => fn.metricErrors()),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Aggregation queue',
        left: [queue.metricApproximateNumberOfMessagesVisible(), dlqDepth],
        width: 12,
      }),
    );

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    // The key's value is a secret, so only its id is exported:
    //   aws apigateway get-api-key --api-key <id> --include-value
    new cdk.CfnOutput(this, 'ApiKeyId', { value: apiKey.keyId });
  }
}
