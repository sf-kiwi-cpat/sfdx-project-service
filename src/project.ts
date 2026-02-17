import fs from 'node:fs/promises';
import path from 'node:path';
import { AuthInfo } from '@salesforce/core';
import { getProjectPath, SF_API_VERSION } from './config.js';

const SFDX_PROJECT_JSON = {
  packageDirectories: [{ path: 'force-app', default: true }],
  namespace: '',
  sfdcLoginUrl: 'https://login.salesforce.com',
  sourceApiVersion: SF_API_VERSION,
};

export interface InitInput {
  accessToken: string;
  instanceUrl: string;
}

/**
 * Scaffold the SFDX project: create directory structure and sfdx-project.json.
 */
export async function scaffoldProject(): Promise<void> {
  const projectPath = getProjectPath();
  const defaultPackagePath = path.join(projectPath, 'force-app', 'main', 'default');

  await fs.mkdir(defaultPackagePath, { recursive: true });

  const configPath = path.join(projectPath, 'sfdx-project.json');
  try {
    await fs.access(configPath);
    // Project already exists - don't overwrite
  } catch {
    await fs.writeFile(configPath, JSON.stringify(SFDX_PROJECT_JSON, null, 2), 'utf-8');
  }
}

/**
 * Connect the org by registering OAuth credentials with AuthInfo.
 * Uses project's .sf directory for config so auth persists on EFS.
 */
export async function connectOrg(input: InitInput): Promise<void> {
  const projectPath = getProjectPath();
  const sfHome = path.join(projectPath, '.sf');
  await fs.mkdir(sfHome, { recursive: true });

  // Point SF config to project dir so auth persists with the project on EFS
  const priorHome = process.env.SF_HOME;
  process.env.SF_HOME = sfHome;

  try {
    const instanceUrl = input.instanceUrl.replace(/\/$/, '');

    const authInfo = await AuthInfo.create({
      accessTokenOptions: {
        accessToken: input.accessToken,
        instanceUrl,
      },
    });

    await authInfo.save();
    await authInfo.setAsDefault({ org: true });
  } finally {
    if (priorHome !== undefined) {
      process.env.SF_HOME = priorHome;
    } else {
      delete process.env.SF_HOME;
    }
  }
}
