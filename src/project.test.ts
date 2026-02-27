import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getProjectPath } from './config.js';

// Track global call order across mocks to assert relative ordering.
const callOrder: string[] = [];

vi.mock('@salesforce/core', () => ({
  AuthInfo: {
    create: vi.fn().mockImplementation(async () => {
      callOrder.push('AuthInfo.create');
      const projectPath = getProjectPath();
      const expectedSfHome = path.join(projectPath, '.sf');
      expect(process.env.HOME).toBe(expectedSfHome);
      return {
        save: vi.fn().mockResolvedValue(undefined),
        setAsDefault: vi.fn().mockResolvedValue(undefined),
      };
    }),
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
  // Dynamic imports so vi.resetModules() gives each test a fresh connectMutex.
  let connectOrg: typeof import('./project.js').connectOrg;
  let AuthInfo: typeof import('@salesforce/core').AuthInfo;
  let StateAggregator: typeof import('@salesforce/core').StateAggregator;

  beforeEach(async () => {
    vi.resetModules();
    const projectMod = await import('./project.js');
    const coreMod = await import('@salesforce/core');
    connectOrg = projectMod.connectOrg;
    AuthInfo = coreMod.AuthInfo;
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

  // We can't verify that auth files actually land in .sf/.sfdx/ because
  // @salesforce/core is fully mocked — AuthInfo.create and save are stubs.
  // A real integration test would need a live org and un-mocked core, which
  // is out of scope for this unit-test suite.
  it('sets HOME to project .sf so auth files land in project-scoped directory', async () => {
    await connectOrg({
      accessToken: 'test-token',
      instanceUrl: 'https://test.salesforce.com',
    });

    expect(AuthInfo.create).toHaveBeenCalledTimes(1);
    expect(process.env.HOME).toBe(originalHome ?? undefined);
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

  it('serializes concurrent connectOrg calls via mutex', async () => {
    // Track HOME observations at each AuthInfo.create entry to prove
    // call-2 doesn't start while call-1 is still in progress.
    const homeAtEntry: string[] = [];
    let resolveFirst: () => void;
    const firstCallGate = new Promise<void>((r) => {
      resolveFirst = r;
    });

    let callCount = 0;
    vi.mocked(AuthInfo.create).mockImplementation(async () => {
      homeAtEntry.push(process.env.HOME ?? '');
      callCount++;
      if (callCount === 1) {
        // Stall the first call — if serialization is broken the second
        // call would enter while we're waiting here.
        await firstCallGate;
      }
      return {
        save: vi.fn().mockResolvedValue(undefined),
        setAsDefault: vi.fn().mockResolvedValue(undefined),
      };
    });

    const p1 = connectOrg({
      accessToken: 'token-1',
      instanceUrl: 'https://org1.salesforce.com',
    });
    const p2 = connectOrg({
      accessToken: 'token-2',
      instanceUrl: 'https://org2.salesforce.com',
    });

    // Give the event loop a chance — if mutex is broken, call-2 would
    // have entered AuthInfo.create by now.
    await new Promise((r) => setTimeout(r, 50));
    expect(homeAtEntry).toHaveLength(1); // only call-1 has entered

    resolveFirst!();
    await Promise.all([p1, p2]);

    expect(AuthInfo.create).toHaveBeenCalledTimes(2);
    // call-2 entered only after call-1 completed
    expect(homeAtEntry).toHaveLength(2);
  });
});
