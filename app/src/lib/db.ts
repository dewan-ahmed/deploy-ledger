import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const tableName = (): string => {
  const name = process.env.TABLE_NAME;
  if (!name) throw new Error('TABLE_NAME is not set');
  return name;
};

// Single-table layout:
//   PK = SERVICE#<service>   SK = EVENT#<deployedAt>#<eventId>   one item per deployment
//   PK = SERVICE#<service>   SK = METRICS                        rolled-up DORA metrics
export const servicePk = (service: string): string => `SERVICE#${service}`;
export const eventSk = (deployedAt: string, eventId: string): string => `EVENT#${deployedAt}#${eventId}`;
export const METRICS_SK = 'METRICS';
export const EVENT_SK_PREFIX = 'EVENT#';
