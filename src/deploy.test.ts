import { describe, it, expect, beforeEach, vi } from 'vitest';

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
} from './deploy.js';

const testCredentials: OrgCredentials = {
  accessToken: 'test-token',
  instanceUrl: 'https://test.salesforce.com',
};

describe('deploy module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthInfoCreate.mockResolvedValue({ mock: 'authInfo' });
    mockConnectionCreate.mockResolvedValue({ mock: 'connection' });
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
    it('calls ComponentSet.fromSource with the project force-app path', () => {
      buildComponentSet('/tmp/test-project');

      expect(mockFromSource).toHaveBeenCalledWith({
        fsPaths: ['/tmp/test-project/force-app'],
      });
    });
  });

  describe('deployMetadata', () => {
    beforeEach(() => {
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
      const result = await deployMetadata('/tmp/test-project', testCredentials);

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

      const result = await deployMetadata('/tmp/test-project', testCredentials);

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

      await expect(deployMetadata('/tmp/test-project', testCredentials)).rejects.toThrow(
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

      await expect(deployMetadata('/tmp/test-project', testCredentials)).rejects.toThrow(
        'Deployment Failed'
      );
    });

    it('passes deployment options to SDR', async () => {
      await deployMetadata('/tmp/test-project', testCredentials);

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
  });
});
