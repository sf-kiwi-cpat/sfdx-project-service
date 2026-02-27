import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Track global call order across mocks to assert relative ordering.
const callOrder: string[] = [];

vi.mock('@salesforce/core', () => ({
  AuthInfo: {
    create: vi.fn().mockImplementation(async () => {
      callOrder.push('AuthInfo.create');
      return {
        save: vi.fn().mockResolvedValue(undefined),
        setAsDefault: vi.fn().mockResolvedValue(undefined),
      };
    }),
  },
  Global: {
    SFDX_STATE_FOLDER: '.sfdx',
  },
  StateAggregator: {
    clearInstance: vi.fn().mockImplementation(() => {
      callOrder.push('StateAggregator.clearInstance');
    }),
  },
}));

describe('connectOrg', () => {
  let tmpDir: string;
  let originalProjectRoot: string | undefined;
  let originalHome: string | undefined;
  // Dynamic imports so vi.resetModules() gives each test a fresh module state.
  let connectOrg: typeof import('./project.js').connectOrg;
  let AuthInfo: typeof import('@salesforce/core').AuthInfo;
  let Global: typeof import('@salesforce/core').Global;
  let StateAggregator: typeof import('@salesforce/core').StateAggregator;

  beforeEach(async () => {
    vi.resetModules();
    const projectMod = await import('./project.js');
    const coreMod = await import('@salesforce/core');
    connectOrg = projectMod.connectOrg;
    AuthInfo = coreMod.AuthInfo;
    Global = coreMod.Global;
    StateAggregator = coreMod.StateAggregator;

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-project-'));
    originalProjectRoot = process.env.PROJECT_ROOT;
    originalHome = process.env.HOME;
    process.env.PROJECT_ROOT = tmpDir;
    vi.mocked(AuthInfo.create).mockClear();
    vi.mocked(StateAggregator.clearInstance).mockClear();
    callOrder.length = 0;
  });

  afterEach(async () => {
    process.env.PROJECT_ROOT = originalProjectRoot;
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('overrides Global.DIR to project-scoped auth directory without mutating HOME', async () => {
    await connectOrg({
      accessToken: 'test-token',
      instanceUrl: 'https://test.salesforce.com',
    });

    expect(AuthInfo.create).toHaveBeenCalledTimes(1);
    // HOME must not be mutated
    expect(process.env.HOME).toBe(originalHome);
    // Global.DIR should resolve to project-scoped path
    const expectedDir = path.join(tmpDir, '.sf', '.sfdx');
    expect(Global.DIR).toBe(expectedDir);
  });

  it('calls clearInstance() before AuthInfo.create()', async () => {
    await connectOrg({
      accessToken: 'test-token',
      instanceUrl: 'https://test.salesforce.com',
    });

    expect(callOrder).toEqual([
      'StateAggregator.clearInstance',
      'AuthInfo.create',
    ]);
  });

  it('handles concurrent connectOrg calls without a mutex', async () => {
    await Promise.all([
      connectOrg({
        accessToken: 'token-1',
        instanceUrl: 'https://org1.salesforce.com',
      }),
      connectOrg({
        accessToken: 'token-2',
        instanceUrl: 'https://org2.salesforce.com',
      }),
    ]);

    expect(AuthInfo.create).toHaveBeenCalledTimes(2);
  });
});
