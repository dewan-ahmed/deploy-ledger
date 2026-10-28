import { randomUUID } from 'crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { doc, eventSk, servicePk, tableName } from '../lib/db';
import { json } from '../lib/http';
import { DeploymentEvent } from '../lib/types';
import { parseEvent } from '../lib/validate';

const sqs = new SQSClient({});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return json(400, { message: 'Body must be valid JSON' });
  }

  const parsed = parseEvent(body);
  if (!parsed.ok) return json(400, { message: parsed.error });

  const record: DeploymentEvent = { ...parsed.value, eventId: randomUUID() };

  await doc.send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        PK: servicePk(record.service),
        SK: eventSk(record.deployedAt, record.eventId),
        ...record,
      },
    }),
  );

  // The event is already durable; the aggregator recomputes metrics asynchronously.
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MessageBody: JSON.stringify({ service: record.service }),
    }),
  );

  return json(201, record);
};
