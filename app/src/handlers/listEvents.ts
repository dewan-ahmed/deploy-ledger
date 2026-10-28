import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { doc, EVENT_SK_PREFIX, servicePk, tableName } from '../lib/db';
import { json } from '../lib/http';
import { isValidServiceName } from '../lib/validate';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const params = event.queryStringParameters ?? {};

  if (!isValidServiceName(params.service)) {
    return json(400, { message: 'Query parameter "service" is required and must be a valid service name' });
  }

  const requested = params.limit === undefined ? DEFAULT_LIMIT : Number(params.limit);
  if (!Number.isInteger(requested) || requested < 1) {
    return json(400, { message: `limit must be an integer between 1 and ${MAX_LIMIT}` });
  }
  const limit = Math.min(requested, MAX_LIMIT);

  const result = await doc.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': servicePk(params.service), ':prefix': EVENT_SK_PREFIX },
      ScanIndexForward: false, // newest first
      Limit: limit,
    }),
  );

  const events = (result.Items ?? []).map(({ PK: _pk, SK: _sk, ...rest }) => rest);
  return json(200, { service: params.service, count: events.length, events });
};
