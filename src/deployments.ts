/*
 * Copyright (c) 2026, Salesforce, Inc.
 * SPDX-License-Identifier: Apache-2
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
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

export interface ProgressEvent {
  deploymentId: string;
  timestamp: string;
  status: string;
  numberComponentsDeployed: number;
  numberComponentsTotal: number;
  components: DeploymentComponentResult[];
}

interface StoredDeployment {
  deploymentId: string;
  projectId: string;
  createdAt: Date;
  result: DeploymentResult | null;
  error: string | null;
  pollPromise: Promise<void> | null;
  progressEvents: ProgressEvent[];
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
    progressEvents: [],
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
 * Get the poll promise for a deployment (if it's still in progress)
 */
export function getDeploymentPollPromise(deploymentId: string): Promise<void> | null {
  const deployment = deploymentStore.get(deploymentId);
  return deployment?.pollPromise ?? null;
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
 * Record a progress event for a deployment
 */
export function addProgressEvent(deploymentId: string, event: ProgressEvent): void {
  const deployment = deploymentStore.get(deploymentId);
  if (deployment) {
    deployment.progressEvents.push(event);
  }
}

/**
 * Get all progress events for a deployment
 */
export function getProgressEvents(deploymentId: string): ProgressEvent[] {
  const deployment = deploymentStore.get(deploymentId);
  return deployment?.progressEvents ?? [];
}

/**
 * Clear all deployments (for testing)
 */
export function clearAllDeployments(): void {
  deploymentStore.clear();
}
