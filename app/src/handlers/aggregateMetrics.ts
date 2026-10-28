import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { doc, EVENT_SK_PREFIX, METRICS_SK, servicePk, tableName } from '../lib/db';
import { computeMetrics } from '../lib/metrics';
import { DeploymentEvent, METRICS_WINDOW_DAYS } from '../lib/types';

const DAY_MS = 24 * 60 * 60 * 1000;

async function loadWindowEvents(service: string, now: Date): Promise<DeploymentEvent[]> {
  const since = new Date(now.getTime() - METRICS_WINDOW_DAYS * DAY_MS).toISOString();
  const events: DeploymentEvent[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await doc.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': servicePk(service),
          ':from': `${EVENT_SK_PREFIX}${since}`,
          ':to': `${EVENT_SK_PREFIX}9999`,
        },
        ExclusiveStartKey: startKey,
      }),
    );
    events.push(...((page.Items ?? []) as DeploymentEvent[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return events;
}

/**
 * Recomputes the rolled-up metrics for every service mentioned in the batch.
 * Several messages for one service collapse into a single recomputation, and a failure
 * only returns the messages for that service so the rest of the batch is not retried.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const messagesByService = new Map<string, string[]>();
  const failures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const { service } = JSON.parse(record.body) as { service?: string };
      if (!service) throw new Error('message has no service');
      messagesByService.set(service, [...(messagesByService.get(service) ?? []), record.messageId]);
    } catch (err) {
      console.error('Unparseable message', record.messageId, err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  const now = new Date();
  for (const [service, messageIds] of messagesByService) {
    try {
      const events = await loadWindowEvents(service, now);
      const metrics = computeMetrics(service, events, METRICS_WINDOW_DAYS, now);
      await doc.send(
        new PutCommand({
          TableName: tableName(),
          Item: { PK: servicePk(service), SK: METRICS_SK, ...metrics },
        }),
      );
    } catch (err) {
      console.error('Failed to aggregate metrics for', service, err);
      failures.push(...messageIds.map((itemIdentifier) => ({ itemIdentifier })));
    }
  }

  return { batchItemFailures: failures };
};
