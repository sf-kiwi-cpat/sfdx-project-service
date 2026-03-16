import fs from 'node:fs/promises';
import path from 'node:path';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { Connection, AuthInfo } from '@salesforce/core';
import { DeploymentError } from './errors.js';
import { logger } from './logger.js';

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
