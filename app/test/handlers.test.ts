import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, SQSEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { handler as aggregateMetrics } from '../src/handlers/aggregateMetrics';
import { handler as createEvent } from '../src/handlers/createEvent';
import { handler as getMetrics } from '../src/handlers/getMetrics';
import { handler as listEvents } from '../src/handlers/listEvents';

const ddb = mockClient(DynamoDBDocumentClient);
const sqs = mockClient(SQSClient);

const apiEvent = (overrides: Partial<APIGatewayProxyEvent>): APIGatewayProxyEvent =>
  ({ body: null, queryStringParameters: null, pathParameters: null, ...overrides }) as APIGatewayProxyEvent;

beforeEach(() => {
  ddb.reset();
  sqs.reset();
  process.env.TABLE_NAME = 'events-table';
  process.env.QUEUE_URL = 'https://sqs.example/queue';
});

describe('createEvent', () => {
  it('stores the event, queues an aggregation and returns 201', async () => {
    ddb.on(PutCommand).resolves({});
    sqs.on(SendMessageCommand).resolves({});

    const res = await createEvent(
      apiEvent({ body: JSON.stringify({ service: 'checkout', environment: 'production', version: '1.0.0', status: 'failure' }) }),
    );

    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body);
    expect(created).toMatchObject({ service: 'checkout', status: 'failure' });
    expect(created.eventId).toEqual(expect.any(String));

    const put = ddb.commandCalls(PutCommand)[0].args[0].input;
    expect(put.TableName).toBe('events-table');
    expect(put.Item).toMatchObject({ PK: 'SERVICE#checkout' });
    expect(put.Item?.SK).toMatch(/^EVENT#.+#.+$/);
    expect(sqs.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody).toBe('{"service":"checkout"}');
  });

  it('rejects invalid JSON and invalid events without touching AWS', async () => {
    expect((await createEvent(apiEvent({ body: '{not json' }))).statusCode).toBe(400);
    expect((await createEvent(apiEvent({ body: JSON.stringify({ service: 'x' }) }))).statusCode).toBe(400);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});

describe('listEvents', () => {
  it('requires a service', async () => {
    expect((await listEvents(apiEvent({}))).statusCode).toBe(400);
  });

  it('queries newest-first, caps the limit and strips key attributes', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ PK: 'SERVICE#checkout', SK: 'EVENT#a#1', eventId: '1', status: 'success' }] });

    const res = await listEvents(apiEvent({ queryStringParameters: { service: 'checkout', limit: '500' } }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ service: 'checkout', count: 1, events: [{ eventId: '1', status: 'success' }] });
    const query = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(query.ScanIndexForward).toBe(false);
    expect(query.Limit).toBe(100);
  });

  it('rejects a non-numeric limit', async () => {
    const res = await listEvents(apiEvent({ queryStringParameters: { service: 'checkout', limit: 'lots' } }));
    expect(res.statusCode).toBe(400);
  });
});

describe('getMetrics', () => {
  it('returns 404 until metrics exist', async () => {
    ddb.on(GetCommand).resolves({});
    expect((await getMetrics(apiEvent({ pathParameters: { id: 'checkout' } }))).statusCode).toBe(404);
  });

  it('returns the stored metrics without key attributes', async () => {
    ddb.on(GetCommand).resolves({ Item: { PK: 'SERVICE#checkout', SK: 'METRICS', service: 'checkout', totalDeployments: 3 } });
    const res = await getMetrics(apiEvent({ pathParameters: { id: 'checkout' } }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ service: 'checkout', totalDeployments: 3 });
  });
});

describe('aggregateMetrics', () => {
  const message = (messageId: string, body: string) => ({ messageId, body }) as SQSEvent['Records'][number];

  it('recomputes each service once per batch and writes the summary', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [{ eventId: '1', service: 'checkout', status: 'success', deployedAt: new Date().toISOString() }],
    });
    ddb.on(PutCommand).resolves({});

    const res = await aggregateMetrics({
      Records: [message('m1', '{"service":"checkout"}'), message('m2', '{"service":"checkout"}')],
    });

    expect(res.batchItemFailures).toEqual([]);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(1);
    const put = ddb.commandCalls(PutCommand)[0].args[0].input;
    expect(put.Item).toMatchObject({ PK: 'SERVICE#checkout', SK: 'METRICS', totalDeployments: 1 });
  });

  it('reports only the affected messages as failures', async () => {
    ddb.on(QueryCommand).rejects(new Error('throttled'));

    const res = await aggregateMetrics({
      Records: [message('m1', '{"service":"checkout"}'), message('m2', 'garbage')],
    });

    expect(res.batchItemFailures.map((f) => f.itemIdentifier).sort()).toEqual(['m1', 'm2']);
  });
});
