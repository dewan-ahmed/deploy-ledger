import { DeploymentEvent, ServiceMetrics } from './types';

const HOUR_MS = 60 * 60 * 1000;

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Computes DORA-style metrics for one service from the events that fall inside the window. */
export function computeMetrics(
  service: string,
  events: DeploymentEvent[],
  windowDays: number,
  now: Date = new Date(),
): ServiceMetrics {
  const total = events.length;
  const failed = events.filter((e) => e.status !== 'success').length;

  const leadTimesHours = events.flatMap((e) => {
    if (!e.commitTime) return [];
    const diff = Date.parse(e.deployedAt) - Date.parse(e.commitTime);
    return diff >= 0 ? [diff / HOUR_MS] : [];
  });

  return {
    service,
    windowDays,
    totalDeployments: total,
    deploymentsPerDay: round(total / windowDays, 3),
    changeFailureRate: total === 0 ? 0 : round(failed / total, 4),
    medianLeadTimeHours: leadTimesHours.length === 0 ? null : round(median(leadTimesHours), 2),
    updatedAt: now.toISOString(),
  };
}
