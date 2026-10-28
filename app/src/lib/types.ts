export type DeploymentStatus = 'success' | 'failure' | 'rollback';

export const DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = ['success', 'failure', 'rollback'];

export interface NewDeploymentEvent {
  service: string;
  environment: string;
  version: string;
  status: DeploymentStatus;
  /** ISO-8601 timestamp of the deployment. Defaults to the time of the request. */
  deployedAt: string;
  /** ISO-8601 timestamp of the commit being deployed. Used for lead time. */
  commitTime?: string;
}

export interface DeploymentEvent extends NewDeploymentEvent {
  eventId: string;
}

export interface ServiceMetrics {
  service: string;
  windowDays: number;
  totalDeployments: number;
  deploymentsPerDay: number;
  /** Share of deployments that ended in failure or rollback, 0..1. */
  changeFailureRate: number;
  /** Median hours from commit to deployment, null when no event carried a commit time. */
  medianLeadTimeHours: number | null;
  updatedAt: string;
}

export const METRICS_WINDOW_DAYS = 30;
