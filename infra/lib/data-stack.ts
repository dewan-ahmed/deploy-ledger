import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/** Stateful resources: the events table and the aggregation queue. */
export class DataStack extends cdk.Stack {
  public readonly table: dynamodb.Table;
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.table = new dynamodb.Table(this, 'EventsTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // This is a demo project, so tear-down should leave nothing behind.
      // Use RETAIN for anything holding real audit data.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.deadLetterQueue = new sqs.Queue(this, 'AggregationDlq', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    this.queue = new sqs.Queue(this, 'AggregationQueue', {
      // Must be at least the consumer Lambda's timeout.
      visibilityTimeout: cdk.Duration.seconds(60),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 3 },
    });
  }
}
