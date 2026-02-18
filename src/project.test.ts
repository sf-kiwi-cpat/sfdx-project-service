import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { connectOrg } from './project.js';
import { getProjectPath } from './config.js';
import { AuthInfo } from '@salesforce/core';

vi.mock('@salesforce/core', () => ({
  AuthInfo: {
    create: vi.fn().mockImplementation(async () => {
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
    clearInstance: vi.fn(),
  },
}));

describe('connectOrg', () => {
  let tmpDir: string;
  let originalProjectRoot: string | undefined;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-project-'));
    originalProjectRoot = process.env.PROJECT_ROOT;
    originalHome = process.env.HOME;
    process.env.PROJECT_ROOT = tmpDir;
    vi.mocked(AuthInfo.create).mockClear();
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

  it('sets HOME to project .sf so auth files land in project-scoped directory', async () => {
    await connectOrg({
      accessToken: 'test-token',
      instanceUrl: 'https://test.salesforce.com',
    });

    expect(AuthInfo.create).toHaveBeenCalledTimes(1);
    expect(process.env.HOME).toBe(originalHome ?? undefined);
  });

  it('serializes concurrent connectOrg calls via mutex', async () => {
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
