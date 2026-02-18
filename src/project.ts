import fs from 'node:fs/promises';
import path from 'node:path';
import { AuthInfo, StateAggregator } from '@salesforce/core';
import { getProjectPath, SF_API_VERSION } from './config.js';

/** Mutex to serialize connectOrg calls — HOME mutation must not race across concurrent requests. */
let connectMutex: Promise<void> = Promise.resolve();

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
 * Serialized via mutex because @salesforce/core uses os.homedir() (reads HOME)
 * and mutating HOME concurrently would race.
 */
export async function connectOrg(input: InitInput): Promise<void> {
  const result = connectMutex.then(() => _connectOrg(input));
  connectMutex = result.catch(() => {});
  return result;
}

async function _connectOrg(input: InitInput): Promise<void> {
  const projectPath = getProjectPath();
  const sfHome = path.join(projectPath, '.sf');
  await fs.mkdir(sfHome, { recursive: true });

  // @salesforce/core uses os.homedir() for Global.DIR, not SF_HOME
  const priorHome = process.env.HOME;
  process.env.HOME = sfHome;

  try {
    StateAggregator.clearInstance();
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
      process.env.HOME = priorHome;
    } else {
      delete process.env.HOME;
    }
  }
}
