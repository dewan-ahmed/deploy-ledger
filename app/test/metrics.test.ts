import { computeMetrics } from '../src/lib/metrics';
import { DeploymentEvent } from '../src/lib/types';

const NOW = new Date('2026-10-28T12:00:00.000Z');

const event = (overrides: Partial<DeploymentEvent>): DeploymentEvent => ({
  eventId: 'id',
  service: 'checkout',
  environment: 'production',
  version: '1.0.0',
  status: 'success',
  deployedAt: '2026-10-27T12:00:00.000Z',
  ...overrides,
});

describe('computeMetrics', () => {
  it('returns zeros and a null lead time when there are no events', () => {
    const m = computeMetrics('checkout', [], 30, NOW);
    expect(m).toMatchObject({
      totalDeployments: 0,
      deploymentsPerDay: 0,
      changeFailureRate: 0,
      medianLeadTimeHours: null,
    });
  });

  it('computes frequency and counts failures and rollbacks as failed changes', () => {
    const events = [
      event({ status: 'success' }),
      event({ status: 'success' }),
      event({ status: 'failure' }),
      event({ status: 'rollback' }),
    ];
    const m = computeMetrics('checkout', events, 30, NOW);
    expect(m.totalDeployments).toBe(4);
    expect(m.deploymentsPerDay).toBe(0.133);
    expect(m.changeFailureRate).toBe(0.5);
  });

  it('uses the median lead time and ignores events without a usable commit time', () => {
    const events = [
      event({ commitTime: '2026-10-27T10:00:00.000Z' }), // 2h
      event({ commitTime: '2026-10-27T06:00:00.000Z' }), // 6h
      event({ commitTime: '2026-10-27T00:00:00.000Z' }), // 12h
      event({ commitTime: '2026-10-28T00:00:00.000Z' }), // after deploy: ignored
      event({}), // no commit time: ignored
    ];
    expect(computeMetrics('checkout', events, 30, NOW).medianLeadTimeHours).toBe(6);
  });

  it('averages the two middle values for an even count', () => {
    const events = [
      event({ commitTime: '2026-10-27T10:00:00.000Z' }), // 2h
      event({ commitTime: '2026-10-27T08:00:00.000Z' }), // 4h
    ];
    expect(computeMetrics('checkout', events, 30, NOW).medianLeadTimeHours).toBe(3);
  });
});
