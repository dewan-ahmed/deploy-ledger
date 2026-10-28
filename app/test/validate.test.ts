import { parseEvent } from '../src/lib/validate';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const valid = { service: 'checkout', environment: 'production', version: '1.4.2', status: 'success' };

describe('parseEvent', () => {
  it('accepts a minimal event and defaults deployedAt to now', () => {
    const result = parseEvent(valid, NOW);
    expect(result).toEqual({
      ok: true,
      value: { ...valid, deployedAt: '2026-10-28T12:00:00.000Z', commitTime: undefined },
    });
  });

  it('normalises timestamps to UTC ISO strings', () => {
    const result = parseEvent({ ...valid, deployedAt: '2026-10-28T08:00:00-04:00', commitTime: '2026-10-28T06:00:00Z' }, NOW);
    expect(result).toMatchObject({
      ok: true,
      value: { deployedAt: '2026-10-28T12:00:00.000Z', commitTime: '2026-10-28T06:00:00.000Z' },
    });
  });

  it.each([
    ['a non-object body', 'nope'],
    ['an array body', []],
    ['a bad service name', { ...valid, service: 'has spaces' }],
    ['a missing environment', { ...valid, environment: undefined }],
    ['an empty version', { ...valid, version: '' }],
    ['an unknown status', { ...valid, status: 'maybe' }],
    ['an invalid deployedAt', { ...valid, deployedAt: 'yesterday-ish' }],
    ['an invalid commitTime', { ...valid, commitTime: 42 }],
  ])('rejects %s', (_label, body) => {
    expect(parseEvent(body, NOW).ok).toBe(false);
  });
});
