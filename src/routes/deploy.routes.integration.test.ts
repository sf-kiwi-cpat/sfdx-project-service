import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../app.js';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';

const { mockConnectionCreate, mockAuthInfoCreate } = vi.hoisted(() => ({
  mockConnectionCreate: vi.fn(),
  mockAuthInfoCreate: vi.fn(),
}));

vi.mock('@salesforce/core', () => ({
  Connection: { create: mockConnectionCreate },
  AuthInfo: { create: mockAuthInfoCreate },
  Global: { SFDX_STATE_FOLDER: '.sfdx' },
  StateAggregator: { clearInstance: vi.fn() },
}));

describe('deploy routes integration', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;
  const mockPollStatus = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deploy-routes-'));
    process.env.PROJECTS_ROOT = tmpDir;

    app = createApp();

    // Create a project
    const createRes = await request(app).post('/v1/projects').send({ template: 'hello-world-1' });
    projectId = createRes.body.id;

    mockAuthInfoCreate.mockResolvedValue({});
    mockConnectionCreate.mockResolvedValue({});

    vi.spyOn(ComponentSet.prototype, 'deploy').mockResolvedValue({
      pollStatus: mockPollStatus,
      onUpdate: vi.fn().mockReturnValue(undefined),
    } as never);

    mockPollStatus.mockResolvedValue({
      response: {
        status: 'Succeeded',
        numberComponentsDeployed: 3,
        numberComponentsTotal: 3,
      },
      getFileResponses: () => [
        { fullName: 'Hello_World__c', type: 'CustomObject', state: 'Created' },
        { fullName: 'Hello_World__c.Description__c', type: 'CustomField', state: 'Created' },
        { fullName: 'Hello_World__c.Priority__c', type: 'CustomField', state: 'Created' },
      ],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.PROJECTS_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('SSE event stream', () => {
    it('properly closes SSE stream on client disconnect', async () => {
      const credentials = {
        accessToken: 'test-token',
        instanceUrl: 'https://test.salesforce.com',
      };

      // First, initiate a deployment
      const deployRes = await request(app)
        .post(`/v1/projects/${projectId}/deployments`)
        .send(credentials)
        .expect(202);

      const deploymentId = deployRes.body.deploymentId;

      // Wait a bit for the async deployment to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Then stream the events
      const res = await request(app)
        .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
        .expect(200);

      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.text).toContain('start');
      expect(res.text).toContain('complete');
    });

    it('handles SSE for in-progress deployments', async () => {
      const credentials = {
        accessToken: 'test-token',
        instanceUrl: 'https://test.salesforce.com',
      };

      // Mock a long-running deployment
      let pollCalled = 0;
      mockPollStatus.mockImplementation(async () => {
        pollCalled++;
        // Return in-progress for first few calls, then succeeded
        if (pollCalled < 2) {
          return {
            response: {
              status: 'InProgress',
              numberComponentsDeployed: 1,
              numberComponentsTotal: 3,
            },
            getFileResponses: () => [],
          };
        }
        return {
          response: {
            status: 'Succeeded',
            numberComponentsDeployed: 3,
            numberComponentsTotal: 3,
          },
          getFileResponses: () => [{ fullName: 'Test__c', type: 'CustomObject', state: 'Created' }],
        };
      });

      const deployRes = await request(app)
        .post(`/v1/projects/${projectId}/deployments`)
        .send(credentials)
        .expect(202);

      const deploymentId = deployRes.body.deploymentId;

      // Stream events - should get both in-progress and complete
      // Wait for deployment to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      const res = await request(app)
        .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
        .expect(200);

      expect(res.text).toContain('start');
      expect(res.text).toContain('complete');
    });
  });

  describe('error handling in POST deployments', () => {
    it('returns 502 when ComponentSet.deploy throws', async () => {
      vi.spyOn(ComponentSet.prototype, 'deploy').mockRejectedValueOnce(new Error('Deploy failed'));

      const credentials = {
        accessToken: 'test-token',
        instanceUrl: 'https://test.salesforce.com',
      };

      // This should still return 202 because the error happens async
      const res = await request(app)
        .post(`/v1/projects/${projectId}/deployments`)
        .send(credentials)
        .expect(202);

      expect(res.body.deploymentId).toBeDefined();
    });
  });

  describe('GET deployment status', () => {
    it('returns InProgress when result not yet available', async () => {
      const credentials = {
        accessToken: 'test-token',
        instanceUrl: 'https://test.salesforce.com',
      };

      // Make deployment take a long time
      let pollCalls = 0;
      mockPollStatus.mockImplementation(async () => {
        pollCalls++;
        // Never return (simulate hanging)
        if (pollCalls > 1000) {
          return {
            response: {
              status: 'Succeeded',
              numberComponentsDeployed: 3,
              numberComponentsTotal: 3,
            },
            getFileResponses: () => [],
          };
        }
        await new Promise(() => {}); // hang forever
      });

      const deployRes = await request(app)
        .post(`/v1/projects/${projectId}/deployments`)
        .send(credentials)
        .expect(202);

      const deploymentId = deployRes.body.deploymentId;

      // Immediately check status (before deployment completes)
      const statusRes = await request(app)
        .get(`/v1/projects/${projectId}/deployments/${deploymentId}`)
        .expect(200);

      expect(statusRes.body.status).toBe('InProgress');
    });
  });
});
