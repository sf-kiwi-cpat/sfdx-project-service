import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const { mockPollStatus, mockDeploy, mockFromSource, mockConnectionCreate, mockAuthInfoCreate } =
  vi.hoisted(() => ({
    mockPollStatus: vi.fn(),
    mockDeploy: vi.fn(),
    mockFromSource: vi.fn(),
    mockConnectionCreate: vi.fn(),
    mockAuthInfoCreate: vi.fn(),
  }));

vi.mock('@salesforce/source-deploy-retrieve', () => ({
  ComponentSet: { fromSource: mockFromSource },
}));

vi.mock('@salesforce/core', () => ({
  Connection: { create: mockConnectionCreate },
  AuthInfo: { create: mockAuthInfoCreate },
  Global: { SFDX_STATE_FOLDER: '.sfdx' },
  StateAggregator: { clearInstance: vi.fn() },
}));

import {
  deployMetadata,
  buildConnection,
  buildComponentSet,
  type OrgCredentials,
} from '../../src/domain/deploy.js';

const testCredentials: OrgCredentials = {
  accessToken: 'test-token',
  instanceUrl: 'https://test.salesforce.com',
};

/** Create a temp project dir with sfdx-project.json containing the given packageDirectories. */
async function createTempProject(packageDirectories: Array<{ path: string }>): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-test-'));
  fsSync.writeFileSync(
    path.join(tmpDir, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories })
  );
  return tmpDir;
}

describe('deploy module', () => {
  let tmpProjectDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthInfoCreate.mockResolvedValue({ mock: 'authInfo' });
    mockConnectionCreate.mockResolvedValue({ mock: 'connection' });
  });

  afterEach(async () => {
    if (tmpProjectDir) {
      await fs.rm(tmpProjectDir, { recursive: true, force: true });
      tmpProjectDir = undefined;
    }
  });

  describe('buildConnection', () => {
    it('creates AuthInfo with the provided credentials and passes it to Connection.create', async () => {
      const conn = await buildConnection(testCredentials);

      expect(mockAuthInfoCreate).toHaveBeenCalledWith({
        accessTokenOptions: {
          accessToken: 'test-token',
          instanceUrl: 'https://test.salesforce.com',
        },
      });
      expect(mockConnectionCreate).toHaveBeenCalledWith({
        authInfo: { mock: 'authInfo' },
      });
      expect(conn).toEqual({ mock: 'connection' });
    });
  });

  describe('buildComponentSet', () => {
    it('reads package directories from sfdx-project.json', async () => {
      tmpProjectDir = await createTempProject([{ path: 'force-app' }]);
      await buildComponentSet(tmpProjectDir);

      expect(mockFromSource).toHaveBeenCalledWith({
        fsPaths: [path.join(tmpProjectDir, 'force-app')],
      });
    });

    it('supports multiple package directories', async () => {
      tmpProjectDir = await createTempProject([{ path: 'force-app' }, { path: 'my-pkg' }]);
      await buildComponentSet(tmpProjectDir);

      expect(mockFromSource).toHaveBeenCalledWith({
        fsPaths: [path.join(tmpProjectDir, 'force-app'), path.join(tmpProjectDir, 'my-pkg')],
      });
    });

    it('throws when packageDirectories is empty', async () => {
      tmpProjectDir = await createTempProject([]);

      await expect(buildComponentSet(tmpProjectDir!)).rejects.toThrow(
        'sfdx-project.json must contain at least one packageDirectory'
      );
    });

    it('throws when sfdx-project.json is missing', async () => {
      tmpProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-test-'));

      await expect(buildComponentSet(tmpProjectDir!)).rejects.toThrow();
    });
  });

  describe('deployMetadata', () => {
    beforeEach(async () => {
      tmpProjectDir = await createTempProject([{ path: 'force-app' }]);
      mockPollStatus.mockResolvedValue({
        response: {
          status: 'Succeeded',
          numberComponentsDeployed: 3,
          numberComponentsTotal: 3,
        },
        getFileResponses: () => [
          { fullName: 'Hello_World__c', type: 'CustomObject', state: 'Created' },
        ],
      });
      mockDeploy.mockResolvedValue({ pollStatus: mockPollStatus });
      mockFromSource.mockReturnValue({ deploy: mockDeploy });
    });

    it('maps SDR result to DeployResponse shape', async () => {
      const result = await deployMetadata(tmpProjectDir!, testCredentials);

      expect(result.ok).toBe(true);
      expect(result.status).toBe('Succeeded');
      expect(result.numberComponentsDeployed).toBe(3);
      expect(result.numberComponentsTotal).toBe(3);
      expect(result.components).toEqual([
        { fullName: 'Hello_World__c', type: 'CustomObject', state: 'Created' },
      ]);
    });

    it('strips extra fields from file responses', async () => {
      mockPollStatus.mockResolvedValue({
        response: {
          status: 'Succeeded',
          numberComponentsDeployed: 1,
          numberComponentsTotal: 1,
        },
        getFileResponses: () => [
          {
            fullName: 'Hello_World__c',
            type: 'CustomObject',
            state: 'Created',
            filePath: '/some/path/should/be/stripped',
          },
        ],
      });

      const result = await deployMetadata(tmpProjectDir!, testCredentials);

      expect(result.components[0]).toEqual({
        fullName: 'Hello_World__c',
        type: 'CustomObject',
        state: 'Created',
      });
      expect(result.components[0]).not.toHaveProperty('filePath');
    });

    it('throws when deployment status is not Succeeded', async () => {
      mockPollStatus.mockResolvedValue({
        response: {
          status: 'Failed',
          numberComponentsDeployed: 0,
          numberComponentsTotal: 3,
          errorMessage: 'Component validation error',
        },
        getFileResponses: () => [],
      });

      await expect(deployMetadata(tmpProjectDir!, testCredentials)).rejects.toThrow(
        'Component validation error'
      );
    });

    it('uses status in error message when errorMessage is absent', async () => {
      mockPollStatus.mockResolvedValue({
        response: {
          status: 'Failed',
          numberComponentsDeployed: 0,
          numberComponentsTotal: 3,
        },
        getFileResponses: () => [],
      });

      await expect(deployMetadata(tmpProjectDir!, testCredentials)).rejects.toThrow(
        'Deployment Failed'
      );
    });

    it('passes deployment options to SDR', async () => {
      await deployMetadata(tmpProjectDir!, testCredentials);

      expect(mockDeploy).toHaveBeenCalledWith(
        expect.objectContaining({
          usernameOrConnection: { mock: 'connection' },
          apiOptions: expect.objectContaining({
            rollbackOnError: true,
            testLevel: 'NoTestRun',
            rest: false,
          }),
        })
      );
    });

    it('wraps non-Error thrown values as DeploymentError', async () => {
      mockConnectionCreate.mockRejectedValue('string-error');

      await expect(deployMetadata(tmpProjectDir!, testCredentials)).rejects.toThrow(
        'Deployment failed'
      );
    });
  });
});
