import fs from 'node:fs/promises';
import path from 'node:path';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { Connection, AuthInfo } from '@salesforce/core';
import { DeploymentError } from '../errors.js';
import { logger } from '../logger.js';
import {
  setDeploymentResult,
  setDeploymentError,
  addProgressEvent,
  type DeploymentResult,
  type ProgressEvent,
  type DeploymentComponentResult,
} from '../deployments.js';

export interface DeployComponentResult {
  fullName: string;
  type: string;
  state: string;
}

export interface DeployResponse {
  ok: true;
  status: string;
  numberComponentsDeployed: number;
  numberComponentsTotal: number;
  components: DeployComponentResult[];
}

export interface OrgCredentials {
  accessToken: string;
  instanceUrl: string;
}

/**
 * Validate credentials format
 */
export function validateCredentials(
  accessToken?: unknown,
  instanceUrl?: unknown
): { valid: false; error: string } | { valid: true } {
  if (!accessToken || typeof accessToken !== 'string') {
    return { valid: false, error: 'accessToken is required and must be a string' };
  }
  if (!instanceUrl || typeof instanceUrl !== 'string') {
    return { valid: false, error: 'instanceUrl is required and must be a string' };
  }

  // Validate instanceUrl is a valid URL
  try {
    new URL(instanceUrl);
  } catch {
    return { valid: false, error: 'instanceUrl must be a valid URL' };
  }

  return { valid: true };
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

export async function deployMetadata(
  projectDir: string,
  credentials: OrgCredentials
): Promise<DeployResponse> {
  logger.info({ projectDir, instanceUrl: credentials.instanceUrl }, 'Starting deployment');

  try {
    const connection = await buildConnection(credentials);
    const components = await buildComponentSet(projectDir);

    const deploy = await components.deploy({
      usernameOrConnection: connection,
      apiOptions: {
        rollbackOnError: true,
        testLevel: 'NoTestRun',
        rest: false,
      },
    });

    const result = await deploy.pollStatus();

    if (result.response.status !== 'Succeeded') {
      const msg = result.response.errorMessage ?? `Deployment ${result.response.status}`;
      logger.error({ projectDir, status: result.response.status }, msg);
      throw new DeploymentError(msg);
    }

    logger.info(
      {
        projectDir,
        status: result.response.status,
        deployed: result.response.numberComponentsDeployed,
        total: result.response.numberComponentsTotal,
      },
      'Deployment succeeded'
    );

    return {
      ok: true,
      status: result.response.status,
      numberComponentsDeployed: result.response.numberComponentsDeployed,
      numberComponentsTotal: result.response.numberComponentsTotal,
      components: result.getFileResponses().map((f) => ({
        fullName: f.fullName,
        type: f.type,
        state: f.state,
      })),
    };
  } catch (err) {
    if (err instanceof DeploymentError) throw err;
    const msg = err instanceof Error ? err.message : 'Deployment failed';
    logger.error({ err, projectDir }, 'Deployment failed');
    throw new DeploymentError(msg);
  }
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
    const components = await buildComponentSet(projectDir);

    const deploy = await components.deploy({
      usernameOrConnection: connection,
      apiOptions: {
        rollbackOnError: true,
        testLevel: 'NoTestRun',
        rest: false,
      },
    });

    // Capture progress events as deployment polls occur
    deploy.onUpdate((response) => {
      const components: DeploymentComponentResult[] = response.getFileResponses().map((f) => ({
        fullName: f.fullName,
        type: f.type,
        state: f.state,
      }));

      const event: ProgressEvent = {
        deploymentId,
        timestamp: new Date().toISOString(),
        status: response.response.status,
        numberComponentsDeployed: response.response.numberComponentsDeployed,
        numberComponentsTotal: response.response.numberComponentsTotal,
        components,
      };

      addProgressEvent(deploymentId, event);
    });

    // Set up a 10-minute timeout for polling to prevent indefinite waits
    const abortSignal = AbortSignal.timeout(10 * 60 * 1000);

    const result = await deploy.pollStatus({ abortSignal });

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

    if (result.response.errorMessage) {
      deploymentResult.errorMessage = result.response.errorMessage;
    }

    logger.info({ deploymentId, status: result.response.status }, 'Async deployment completed');
    setDeploymentResult(deploymentId, deploymentResult);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Deployment failed';
    logger.error({ deploymentId, err }, 'Async deployment failed');
    setDeploymentError(deploymentId, msg);
  }
}
