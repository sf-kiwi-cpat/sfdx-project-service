import fs from 'node:fs/promises';
import path from 'node:path';
import { AuthInfo, Global, StateAggregator } from '@salesforce/core';
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
 * Override Global.DIR so @salesforce/core writes auth files to the project-scoped
 * directory ({projectPath}/.sf/.sfdx/) instead of ~/.sfdx/. This replaces the
 * prior approach of mutating process.env.HOME, which was process-global and
 * observable by all concurrent request handlers during await points. The getter
 * resolves getProjectPath() at call time, so it stays correct if PROJECT_ROOT
 * changes (e.g. in tests). See #11.
 */
let globalDirOverridden = false;
function ensureGlobalDirOverride(): void {
  if (globalDirOverridden) return;
  Object.defineProperty(Global, 'DIR', {
    get: () => path.join(getProjectPath(), '.sf', Global.SFDX_STATE_FOLDER),
    configurable: true,
  });
  globalDirOverridden = true;
}

/**
 * Connect the org by registering credentials with AuthInfo.
 * Auth files are written to {projectPath}/.sf/.sfdx/<username>.json via a
 * Global.DIR override — no process.env.HOME mutation, no mutex needed.
 */
export async function connectOrg(input: InitInput): Promise<void> {
  ensureGlobalDirOverride();

  const projectPath = getProjectPath();
  const authDir = path.join(projectPath, '.sf', Global.SFDX_STATE_FOLDER);
  await fs.mkdir(authDir, { recursive: true });

  // clearInstance() must be called after ensureGlobalDirOverride(): its default
  // arg resolves Global.DIR at call time to determine which cache entry to evict.
  // Without this, @salesforce/core reuses a cached StateAggregator pointing at the
  // old path, defeating project-scoped auth isolation. See #12.
  StateAggregator.clearInstance();
  const instanceUrl = input.instanceUrl.replace(/\/$/, '');

  // IMPORTANT: Do not pass `username` here. Without it, AuthInfo.create() calls
  // retrieveUserInfo() to fetch the real org username, which is required for
  // authInfo.save() to actually persist to disk. In @salesforce/core v8, save()
  // silently no-ops when the username is an opaque access token — passing the
  // access token as username would cause auth to stop persisting with no error.
  const authInfo = await AuthInfo.create({
    accessTokenOptions: {
      accessToken: input.accessToken,
      instanceUrl,
    },
  });

  await authInfo.save();
  await authInfo.setAsDefault({ org: true });
}
