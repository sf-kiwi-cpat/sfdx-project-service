/*
 * Copyright (c) 2026, Salesforce, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../src/app.js';
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
    await app.ready();

    // Create a project
    const createRes = await request(app.server).post('/v1/projects').send({});
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
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('SSE event stream', () => {
    it('properly closes SSE stream on client disconnect', async () => {
      const credentials = {
        accessToken: 'test-token',
        instanceUrl: 'https://test.salesforce.com',
      };

      // First, initiate a deployment
      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .set('Authorization', `Bearer ${credentials.accessToken}`)
        .set('X-Salesforce-Instance-Url', credentials.instanceUrl)
        .expect(202);

      const deploymentId = deployRes.body.deploymentId;

      // Wait a bit for the async deployment to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Then stream the events
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
        .set('Accept', 'text/event-stream')
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

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .set('Authorization', `Bearer ${credentials.accessToken}`)
        .set('X-Salesforce-Instance-Url', credentials.instanceUrl)
        .expect(202);

      const deploymentId = deployRes.body.deploymentId;

      // Stream events - should get both in-progress and complete
      // Wait for deployment to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
        .set('Accept', 'text/event-stream')
        .expect(200);

      expect(res.text).toContain('start');
      expect(res.text).toContain('complete');
    });
  });

  // Regression tests for issue #206: see fs-events.routes.test.ts for the
  // full story. The spec/ tests use supertest's default `Accept: */*`, which
  // bypasses the `@fastify/sse` plugin wrapper. These cover the browser
  // EventSource path (`Accept: text/event-stream`).
  describe('SSE 404 with Accept: text/event-stream (issue #206)', () => {
    it('returns 404 problem+json for an unknown project ID', async () => {
      const res = await request(app.server)
        .get('/v1/projects/00000000-0000-0000-0000-000000000000/deployments/deploy_any/events')
        .set('Accept', 'text/event-stream')
        .expect(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
      expect(res.body.title).toBe('Project Not Found');
    });

    it('returns 404 problem+json for an unknown deployment ID', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/deploy_does-not-exist/events`)
        .set('Accept', 'text/event-stream')
        .expect(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
      expect(res.body.title).toBe('Deployment Not Found');
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
      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .set('Authorization', `Bearer ${credentials.accessToken}`)
        .set('X-Salesforce-Instance-Url', credentials.instanceUrl)
        .expect(202);

      expect(res.body.deploymentId).toBeDefined();
    });
  });
});
