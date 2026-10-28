import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { doc, METRICS_SK, servicePk, tableName } from '../lib/db';
import { json } from '../lib/http';
import { isValidServiceName } from '../lib/validate';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const service = event.pathParameters?.id;
  if (!isValidServiceName(service)) {
    return json(400, { message: 'Path parameter "id" must be a valid service name' });
  }

  const result = await doc.send(
    new GetCommand({ TableName: tableName(), Key: { PK: servicePk(service), SK: METRICS_SK } }),
  );

  if (!result.Item) {
    return json(404, { message: `No metrics yet for service "${service}"` });
  }

  const { PK: _pk, SK: _sk, ...metrics } = result.Item;
  return json(200, metrics);
};
