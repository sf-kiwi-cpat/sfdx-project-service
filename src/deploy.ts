import path from 'node:path';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { Connection, AuthInfo } from '@salesforce/core';

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
 * Replaces the old VirtualTreeContainer approach with hardcoded XML.
 */
export function buildComponentSet(projectDir: string): ComponentSet {
  return ComponentSet.fromSource({
    fsPaths: [path.join(projectDir, 'force-app')],
  });
}

export async function deployMetadata(
  projectDir: string,
  credentials: OrgCredentials
): Promise<DeployResponse> {
  const connection = await buildConnection(credentials);
  const components = buildComponentSet(projectDir);

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
    throw new Error(msg);
  }

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
}
