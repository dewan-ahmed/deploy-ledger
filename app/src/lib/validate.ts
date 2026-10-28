import { DEPLOYMENT_STATUSES, DeploymentStatus, NewDeploymentEvent } from './types';

export type ParseResult = { ok: true; value: NewDeploymentEvent } | { ok: false; error: string };

const SERVICE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function isValidServiceName(value: unknown): value is string {
  return typeof value === 'string' && SERVICE_PATTERN.test(value);
}

function parseTimestamp(value: unknown, field: string): { ok: true; iso: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return { ok: false, error: `${field} must be an ISO-8601 timestamp` };
  }
  // Normalise so that string ordering of timestamps matches chronological ordering.
  return { ok: true, iso: new Date(value).toISOString() };
}

export function parseEvent(body: unknown, now: Date = new Date()): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const input = body as Record<string, unknown>;

  if (!isValidServiceName(input.service)) {
    return { ok: false, error: 'service must be 1-64 characters: letters, digits, ".", "_" or "-"' };
  }
  if (typeof input.environment !== 'string' || input.environment.length === 0 || input.environment.length > 32) {
    return { ok: false, error: 'environment must be a string of 1-32 characters' };
  }
  if (typeof input.version !== 'string' || input.version.length === 0 || input.version.length > 64) {
    return { ok: false, error: 'version must be a string of 1-64 characters' };
  }
  if (!DEPLOYMENT_STATUSES.includes(input.status as DeploymentStatus)) {
    return { ok: false, error: `status must be one of: ${DEPLOYMENT_STATUSES.join(', ')}` };
  }

  let deployedAt = now.toISOString();
  if (input.deployedAt !== undefined) {
    const parsed = parseTimestamp(input.deployedAt, 'deployedAt');
    if (!parsed.ok) return parsed;
    deployedAt = parsed.iso;
  }

  let commitTime: string | undefined;
  if (input.commitTime !== undefined) {
    const parsed = parseTimestamp(input.commitTime, 'commitTime');
    if (!parsed.ok) return parsed;
    commitTime = parsed.iso;
  }

  return {
    ok: true,
    value: {
      service: input.service,
      environment: input.environment,
      version: input.version,
      status: input.status as DeploymentStatus,
      deployedAt,
      commitTime,
    },
  };
}
