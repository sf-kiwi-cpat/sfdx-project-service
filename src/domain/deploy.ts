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
import { type ResolvedAuth } from './auth.js';
import {
  setDeploymentResult,
  setDeploymentError,
  addProgressEvent,
  addStageEvent,
  addWarningEvent,
  type DeploymentResult,
  type ProgressEvent,
  type DeploymentComponentResult,
  type DeploymentStageSummary,
  type DeploymentWarning,
} from '../deployments.js';
import { hasReactFiles, runViteBuild } from './build.js';

/**
 * A single stage in a multi-manifest deploy. Declared in a template's
 * `template.json` under `deployStages`. Templates that do not declare
 * `deployStages` run a single-pass `ComponentSet.fromSource(force-app)`
 * deploy for backward compatibility.
 */
export interface DeployStage {
  manifest: string;
  optional?: boolean;
}

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
 * Build a Salesforce connection from resolved auth.
 * Supports both environment auth (username-based) and legacy credential headers.
 *
 * For environment auth, proactively refreshes the access token before
 * returning. `AuthInfo.create({ username })` reads whatever access token is
 * stored in the SFDX keychain — which may already be expired. Forcing a
 * refresh up front turns stale-token failures into one clean synchronous
 * error (caught by the caller as 502 Deployment Failed) instead of a fuzzy
 * mid-deploy 401 that SDR's auto-retry *usually* hides but can confuse when
 * combined with unrelated failures. Mirrors the pattern in
 * sfdx-agent-sdk's SfCoreOrgAuthResolver.resolve.
 *
 * `refreshAuth` is called defensively — test mocks of @salesforce/core's
 * Connection don't always implement it, and we don't want to force every
 * existing mock boundary to expand. If the method is missing we skip it;
 * real @salesforce/core Connection instances always have it.
 */
export async function buildConnectionFromAuth(auth: ResolvedAuth): Promise<Connection> {
  if (auth.type === 'environment') {
    const authInfo = await AuthInfo.create({ username: auth.username });
    const conn = await Connection.create({ authInfo });
    if (typeof (conn as { refreshAuth?: () => Promise<void> }).refreshAuth === 'function') {
      await conn.refreshAuth();
    }
    return conn;
  }
  return buildConnection(auth);
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
 * Read the project's declared deploy stages, if any.
 *
 * Templates MAY declare `deployStages` in their `template.json` to run
 * multiple manifest-based deploys in order (e.g. schema → flows →
 * bundles). If `template.json` doesn't exist or doesn't declare
 * `deployStages`, returns `undefined` — the caller should fall back to
 * the legacy single-pass `ComponentSet.fromSource(force-app)` deploy.
 */
export async function readDeployStages(projectDir: string): Promise<DeployStage[] | undefined> {
  try {
    const raw = await fs.readFile(path.join(projectDir, 'template.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { deployStages?: DeployStage[] };
    if (Array.isArray(parsed.deployStages) && parsed.deployStages.length > 0) {
      return parsed.deployStages;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derive the instanceUrl from the resolved auth + live connection. For
 * environment auth we ask the connection; for legacy credential auth
 * we already have it on the auth payload.
 */
function instanceUrlFor(
  auth: ResolvedAuth | OrgCredentials,
  connection: Connection
): string | undefined {
  if ('type' in auth) {
    if (auth.type === 'credentials') {
      return auth.instanceUrl;
    }
    return connection.getAuthInfoFields().instanceUrl;
  }
  return auth.instanceUrl;
}

/**
 * Run a single ComponentSet deploy and return both the SDR response and
 * the extracted file responses. Shared by single-pass and staged deploys.
 */
async function runOneDeploy(
  deploymentId: string,
  components: ComponentSet,
  connection: Connection
): Promise<{
  status: string;
  numberComponentsDeployed: number;
  numberComponentsTotal: number;
  errorMessage?: string;
  fileResponses: Array<{ fullName: string; type: string; state: string }>;
}> {
  const deploy = await components.deploy({
    usernameOrConnection: connection,
    apiOptions: {
      rollbackOnError: true,
      testLevel: 'NoTestRun',
      rest: false,
    },
  });

  /* v8 ignore next 3 -- only fires during real SDR polling, not mocked tests */
  deploy.onUpdate((statusUpdate: Record<string, unknown>) => {
    addProgressEvent(deploymentId, mapStatusToProgressEvent(deploymentId, statusUpdate));
  });

  // 60-minute polling budget (3600 × 1s) — caps runaway Metadata API waits.
  const result = await deploy.pollStatus(undefined, 3600);
  return {
    status: result.response.status,
    numberComponentsDeployed: result.response.numberComponentsDeployed,
    numberComponentsTotal: result.response.numberComponentsTotal,
    errorMessage: result.response.errorMessage,
    fileResponses: result.getFileResponses(),
  };
}

/**
 * Run a multi-manifest staged deploy.
 *
 * For each declared stage we build a ComponentSet from its manifest XML
 * and run it against Salesforce sequentially. Required-stage failures
 * abort the remaining stages; optional-stage failures emit a warning
 * SSE event and continue.
 *
 * Staged deploys skip the React/Vite build step because stage manifests
 * target explicit metadata components rather than webapp source output.
 * A future PR can add per-stage build hooks if templates need them.
 *
 * Aggregated result shape:
 *   status = 'Failed'                 — any required stage failed
 *   status = 'SucceededWithWarnings' — all required stages succeeded,
 *                                       at least one optional failed
 *   status = 'Succeeded'              — every stage succeeded
 *   numberComponents* are summed across all attempted stages.
 *   appUrl is set from the LAST stage that surfaced a WebApplication.
 */
async function runStagedDeploy(
  deploymentId: string,
  projectDir: string,
  stages: DeployStage[],
  auth: ResolvedAuth | OrgCredentials,
  connection: Connection
): Promise<void> {
  const stageSummaries: DeploymentStageSummary[] = [];
  const warnings: DeploymentWarning[] = [];
  const allFileResponses: Array<{ fullName: string; type: string; state: string }> = [];
  let numberComponentsDeployed = 0;
  let numberComponentsTotal = 0;
  let failedRequiredStage: string | undefined;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    // Emit a stage event before each stage so clients can show progress.
    addStageEvent(deploymentId, {
      deploymentId,
      name: stage.manifest,
      index: i,
      total: stages.length,
    });

    // Build the ComponentSet from the manifest XML on disk. ComponentSet
    // resolves manifest paths relative to the sfdx-project package dirs,
    // so we pass an absolute path to avoid ambiguity.
    const manifestPath = path.join(projectDir, stage.manifest);
    const components = await ComponentSet.fromManifest({
      manifestPath,
      resolveSourcePaths: [projectDir],
    });

    const runResult = await runOneDeploy(deploymentId, components, connection);

    const summary: DeploymentStageSummary = {
      name: stage.manifest,
      status: runResult.status,
      numberComponentsDeployed: runResult.numberComponentsDeployed,
      numberComponentsTotal: runResult.numberComponentsTotal,
    };
    if (runResult.errorMessage) summary.errorMessage = runResult.errorMessage;
    stageSummaries.push(summary);

    numberComponentsDeployed += runResult.numberComponentsDeployed ?? 0;
    numberComponentsTotal += runResult.numberComponentsTotal ?? 0;
    for (const f of runResult.fileResponses) {
      allFileResponses.push(f);
    }

    const stageFailed = runResult.status !== 'Succeeded';
    if (stageFailed) {
      if (stage.optional) {
        // Optional stage failed — emit a warning and continue.
        const warning: DeploymentWarning = {
          stage: stage.manifest,
          errorMessage: runResult.errorMessage ?? `Stage '${stage.manifest}' failed`,
        };
        warnings.push(warning);
        addWarningEvent(deploymentId, warning);
      } else {
        // Required stage failed — abort remaining stages.
        failedRequiredStage = stage.manifest;
        break;
      }
    }
  }

  let aggregateStatus: string;
  if (failedRequiredStage) {
    aggregateStatus = 'Failed';
  } else if (warnings.length > 0) {
    aggregateStatus = 'SucceededWithWarnings';
  } else {
    aggregateStatus = 'Succeeded';
  }

  const deploymentResult: DeploymentResult = {
    deploymentId,
    status: aggregateStatus,
    numberComponentsDeployed,
    numberComponentsTotal,
    components: allFileResponses.map((f) => ({
      fullName: f.fullName,
      type: f.type,
      state: f.state,
    })),
    stages: stageSummaries,
  };

  if (warnings.length > 0) {
    deploymentResult.warnings = warnings;
  }
  if (failedRequiredStage) {
    deploymentResult.failedStage = failedRequiredStage;
  }

  // appUrl comes from the LAST stage that surfaced a WebApplication —
  // a later stage's webapp supersedes an earlier one. Skip on failure
  // so partially-deployed apps don't get a misleading URL.
  if (aggregateStatus !== 'Failed') {
    const webApp = [...allFileResponses].reverse().find((f) => f.type === 'WebApplication');
    if (webApp) {
      const instanceUrl = instanceUrlFor(auth, connection);
      if (instanceUrl) {
        deploymentResult.appUrl = `${instanceUrl}/lwr/application/ai/c-${webApp.fullName}`;
      }
    }
  }

  logger.info({ deploymentId, status: aggregateStatus }, 'Staged deployment completed');
  setDeploymentResult(deploymentId, deploymentResult);
}

/**
 * Start an async deployment and store the result when complete.
 * This function runs the deployment in the background without blocking.
 * Does not throw errors; stores all results (success and failure) in the deployment store.
 *
 * Deployment lifecycle:
 * 1. Connection is built and validated against Salesforce org
 * 2. If the project's template.json declares `deployStages`, run each
 *    manifest-based deploy in order (staged mode); otherwise build a
 *    ComponentSet from `force-app` sources and run a single deploy.
 * 3. Stage/progress/warning events are recorded as the deploy runs.
 * 4. Final result is stored in the deployment store (success or error).
 *
 * Connection is built twice: once for validation in the POST handler,
 * and again here for the actual deployment. This ensures early error reporting
 * while keeping the async background work isolated and retryable.
 */
export async function deployMetadataAsync(
  deploymentId: string,
  projectDir: string,
  auth: ResolvedAuth | OrgCredentials
): Promise<void> {
  try {
    logger.info({ deploymentId, projectDir }, 'Starting async deployment');

    // Support both ResolvedAuth (new) and OrgCredentials (legacy/existing tests)
    const connection =
      'type' in auth ? await buildConnectionFromAuth(auth) : await buildConnection(auth);

    // Staged-deploy branch: if the project's template.json declares
    // `deployStages`, dispatch each manifest deploy in sequence.
    const stages = await readDeployStages(projectDir);
    if (stages) {
      await runStagedDeploy(deploymentId, projectDir, stages, auth, connection);
      return;
    }

    // Legacy single-pass deploy: build React project if present, then
    // run one ComponentSet.fromSource() deploy over `force-app`.
    if (await hasReactFiles(projectDir)) {
      await runViteBuild(projectDir);
    }

    const components = await buildComponentSet(projectDir);
    const runResult = await runOneDeploy(deploymentId, components, connection);

    const deploymentResult: DeploymentResult = {
      deploymentId,
      status: runResult.status,
      numberComponentsDeployed: runResult.numberComponentsDeployed,
      numberComponentsTotal: runResult.numberComponentsTotal,
      components: runResult.fileResponses.map((f) => ({
        fullName: f.fullName,
        type: f.type,
        state: f.state,
      })),
    };

    /* v8 ignore next 3 -- only set when Salesforce returns an error message */
    if (runResult.errorMessage) {
      deploymentResult.errorMessage = runResult.errorMessage;
    }

    // appUrl is surfaced only on success — a Failed single-pass deploy
    // must not yield a misleading webapp URL.
    if (runResult.status === 'Succeeded') {
      const webApp = runResult.fileResponses.find((f) => f.type === 'WebApplication');
      if (webApp) {
        const instanceUrl = instanceUrlFor(auth, connection);
        if (instanceUrl) {
          deploymentResult.appUrl = `${instanceUrl}/lwr/application/ai/c-${webApp.fullName}`;
        }
      }
    }

    logger.info({ deploymentId, status: runResult.status }, 'Async deployment completed');
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
