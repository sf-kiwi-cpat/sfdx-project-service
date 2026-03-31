/*
 * Copyright (c) 2026, Salesforce, Inc.
 * SPDX-License-Identifier: Apache-2.0
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

import fs from 'node:fs/promises';
import path from 'node:path';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { Connection, AuthInfo } from '@salesforce/core';
import { logger } from '../logger.js';
import { type OrgCredentials } from '../utils/auth.js';
import {
  setDeploymentResult,
  setDeploymentError,
  addProgressEvent,
  type DeploymentResult,
  type ProgressEvent,
  type DeploymentComponentResult,
} from '../deployments.js';
import { hasReactFiles, runViteBuild } from './build.js';

export async function buildConnection(credentials: OrgCredentials): Promise<Connection> {
  const authInfo = await AuthInfo.create({
    accessTokenOptions: {
      accessToken: credentials.accessToken,
      instanceUrl: credentials.instanceUrl,
    },
  });
  return Connection.create({ authInfo });
}

/**
 * Build a ComponentSet from the real metadata files on disk.
 * Reads package directories from sfdx-project.json instead of hardcoding paths.
 */
export async function buildComponentSet(projectDir: string): Promise<ComponentSet> {
  const configPath = path.join(projectDir, 'sfdx-project.json');
  const raw = await fs.readFile(configPath, 'utf-8');
  const config = JSON.parse(raw) as { packageDirectories: Array<{ path: string }> };
  if (!config.packageDirectories?.length) {
    throw new Error('sfdx-project.json must contain at least one packageDirectory');
  }
  const fsPaths = config.packageDirectories.map((d) => path.join(projectDir, d.path));
  logger.info({ fsPaths }, 'Building ComponentSet from source paths');
  return ComponentSet.fromSource({ fsPaths });
}

/**
 * Start an async deployment and store the result when complete.
 * This function runs the deployment in the background without blocking.
 * Does not throw errors; stores all results (success and failure) in the deployment store.
 *
 * Deployment lifecycle:
 * 1. Connection is built and validated against Salesforce org
 * 2. ComponentSet is built from metadata files on disk
 * 3. deploy() is called with SDR (triggers Metadata API request)
 * 4. pollStatus() is called with 10-minute timeout to wait for completion
 * 5. Result is stored in the deployment store (success or error)
 *
 * Progress events are emitted via the onUpdate callback as polling occurs.
 * See the deploy.routes.ts SSE endpoint for how to consume progress events.
 *
 * Connection is built twice: once for validation in the POST handler,
 * and again here for the actual deployment. This ensures early error reporting
 * while keeping the async background work isolated and retryable.
 */
export async function deployMetadataAsync(
  deploymentId: string,
  projectDir: string,
  credentials: OrgCredentials
): Promise<void> {
  try {
    logger.info({ deploymentId, projectDir }, 'Starting async deployment');

    const connection = await buildConnection(credentials);

    // Build React projects before deploying
    if (await hasReactFiles(projectDir)) {
      await runViteBuild(projectDir);
    }

    const components = await buildComponentSet(projectDir);

    const deploy = await components.deploy({
      usernameOrConnection: connection,
      apiOptions: {
        rollbackOnError: true,
        testLevel: 'NoTestRun',
        rest: false,
      },
    });

    // Capture progress events as deployment polls occur — only fires during real SDR polling
    /* v8 ignore next 3 */
    deploy.onUpdate((statusUpdate: Record<string, unknown>) => {
      addProgressEvent(deploymentId, mapStatusToProgressEvent(deploymentId, statusUpdate));
    });

    // Set up a 10-minute timeout for polling to prevent indefinite waits (600,000 ms)
    const result = await deploy.pollStatus(undefined, 600);

    // Store result regardless of success or failure
    const deploymentResult: DeploymentResult = {
      deploymentId,
      status: result.response.status,
      numberComponentsDeployed: result.response.numberComponentsDeployed,
      numberComponentsTotal: result.response.numberComponentsTotal,
      components: result.getFileResponses().map((f) => ({
        fullName: f.fullName,
        type: f.type,
        state: f.state,
      })),
    };

    /* v8 ignore next 3 -- only set when Salesforce returns an error message */
    if (result.response.errorMessage) {
      deploymentResult.errorMessage = result.response.errorMessage;
    }

    const webApp = result.getFileResponses().find((f) => f.type === 'WebApplication');
    if (webApp) {
      deploymentResult.appUrl = `${credentials.instanceUrl}/lwr/application/ai/c-${webApp.fullName}`;
    }

    logger.info({ deploymentId, status: result.response.status }, 'Async deployment completed');
    setDeploymentResult(deploymentId, deploymentResult);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Deployment failed';
    logger.error({ deploymentId, err }, 'Async deployment failed');
    setDeploymentError(deploymentId, msg);
  }
}

/**
 * Map an SDR status update into a ProgressEvent.
 * Extracted as a pure function for testability.
 */
export function mapStatusToProgressEvent(
  deploymentId: string,
  statusUpdate: Record<string, unknown>
): ProgressEvent {
  const getFileResponses = statusUpdate.getFileResponses as
    | (() => Array<{ fullName: string; type: string; state: string }>)
    | undefined;
  const components: DeploymentComponentResult[] = (getFileResponses?.() || []).map((f) => ({
    fullName: f.fullName,
    type: f.type,
    state: f.state,
  }));

  return {
    deploymentId,
    timestamp: new Date().toISOString(),
    status: (statusUpdate.status as string) || 'InProgress',
    numberComponentsDeployed: (statusUpdate.numberComponentsDeployed as number) || 0,
    numberComponentsTotal: (statusUpdate.numberComponentsTotal as number) || 0,
    components,
  };
}
