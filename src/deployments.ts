/**
 * Deployment storage and tracking system.
 * Stores deployment state in memory keyed by deploymentId.
 * Each deployment tracks its status, metadata, and results.
 */

export interface DeploymentComponentResult {
  fullName: string;
  type: string;
  state: string;
}

export interface DeploymentResult {
  deploymentId: string;
  status: string;
  numberComponentsDeployed?: number;
  numberComponentsTotal?: number;
  components?: DeploymentComponentResult[];
  errorMessage?: string;
}

interface StoredDeployment {
  deploymentId: string;
  projectId: string;
  createdAt: Date;
  result: DeploymentResult | null;
  error: string | null;
  pollPromise: Promise<void> | null;
}

const deploymentStore = new Map<string, StoredDeployment>();

/**
 * Generate a unique deployment ID with deploy_ prefix
 */
function generateDeploymentId(): string {
  return `deploy_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a new deployment record and return the deployment ID
 */
export function createDeployment(projectId: string): string {
  const deploymentId = generateDeploymentId();
  deploymentStore.set(deploymentId, {
    deploymentId,
    projectId,
    createdAt: new Date(),
    result: null,
    error: null,
    pollPromise: null,
  });
  return deploymentId;
}

/**
 * Set the poll promise for a deployment to prevent multiple simultaneous polls
 */
export function setDeploymentPollPromise(deploymentId: string, promise: Promise<void>): void {
  const deployment = deploymentStore.get(deploymentId);
  if (deployment) {
    deployment.pollPromise = promise;
  }
}

/**
 * Store the deployment result after polling
 */
export function setDeploymentResult(deploymentId: string, result: DeploymentResult): void {
  const deployment = deploymentStore.get(deploymentId);
  if (deployment) {
    deployment.result = result;
  }
}

/**
 * Store a deployment error
 */
export function setDeploymentError(deploymentId: string, error: string): void {
  const deployment = deploymentStore.get(deploymentId);
  if (deployment) {
    deployment.error = error;
  }
}

/**
 * Get the current deployment result or null if not yet polled
 */
export function getDeploymentResult(deploymentId: string): DeploymentResult | null {
  const deployment = deploymentStore.get(deploymentId);
  return deployment?.result ?? null;
}

/**
 * Check if a deployment exists
 */
export function deploymentExists(deploymentId: string): boolean {
  return deploymentStore.has(deploymentId);
}

/**
 * Get full deployment state for a given ID
 */
export function getDeployment(deploymentId: string): StoredDeployment | null {
  return deploymentStore.get(deploymentId) ?? null;
}

/**
 * Clear all deployments (for testing)
 */
export function clearAllDeployments(): void {
  deploymentStore.clear();
}
