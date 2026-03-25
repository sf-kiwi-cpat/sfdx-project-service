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

/**
 * SPEC TESTS — Human-guarded contract (SDLC 2026)
 *
 * These tests define the contract for:
 * - POST /v1/projects/:id/deployments — initiate deployment
 * - GET /v1/projects/:id/deployments/:deploymentId — poll deployment status
 * - GET /v1/projects/:id/deployments/:deploymentId/events — stream SSE events
 *
 * The contract is async: POST returns 202 Accepted with a deploymentId,
 * then the client polls status or streams events in real-time.
 *
 * These tests are the source of truth for this endpoint's external behavior.
 * The AI implementation agent must NOT modify this file.
 *
 * SDR (source-deploy-retrieve) runs for REAL here — ComponentSet.fromSource()
 * actually parses and validates the metadata files on disk.
 * Only the network boundary is mocked: @salesforce/core (auth) and
 * ComponentSet.prototype.deploy (Metadata API call).
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';

// Only mock @salesforce/core (auth requires network). SDR runs for real.
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

import { createApp } from '../../src/app.js';
import {
  TEST_CREDENTIALS,
  setupTempProject,
  cleanupTempProject,
  setupDefaultMocks,
  createSuccessDeployResponse,
  createInProgressDeployResponse,
  createFailedDeployResponse,
  setupDeployMock,
} from './fixtures.js';

describe('POST /v1/projects/:id/deployments', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;
  const mockPollStatus = vi.fn();

  beforeAll(async () => {
    const setup = await setupTempProject();
    tmpDir = setup.tmpDir;
    projectId = setup.projectId;
  });

  afterAll(async () => {
    await cleanupTempProject(tmpDir);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createApp();
    await app.ready();

    setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
    setupDeployMock(mockPollStatus);
    mockPollStatus.mockResolvedValue(createSuccessDeployResponse());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('returns 202 Accepted with deploymentId and initial status', async () => {
    const res = await request(app.server)
      .post(`/v1/projects/${projectId}/deployments`)
      .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
      .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
      .expect(202);

    expect(res.body).toHaveProperty('deploymentId');
    expect(res.body).toHaveProperty('status');
    expect(typeof res.body.deploymentId).toBe('string');
    expect(res.body.deploymentId).toMatch(/^deploy_/);
  });

  it('returns 400 when credentials are missing', async () => {
    const res = await request(app.server).post(`/v1/projects/${projectId}/deployments`).expect(400);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.status).toBe(400);
    expect(res.body.title).toBe('Bad Request');
  });

  it('returns 400 when accessToken is missing', async () => {
    const res = await request(app.server)
      .post(`/v1/projects/${projectId}/deployments`)
      .set('X-Salesforce-Instance-Url', 'https://test.salesforce.com')
      .expect(400);

    expect(res.body.status).toBe(400);
  });

  it('returns 400 when instanceUrl is missing', async () => {
    const res = await request(app.server)
      .post(`/v1/projects/${projectId}/deployments`)
      .set('Authorization', 'Bearer some-token')
      .expect(400);

    expect(res.body.status).toBe(400);
  });

  it('returns 400 when instanceUrl is not a valid URL', async () => {
    const res = await request(app.server)
      .post(`/v1/projects/${projectId}/deployments`)
      .set('Authorization', 'Bearer token')
      .set('X-Salesforce-Instance-Url', 'not-a-url')
      .expect(400);

    expect(res.body.status).toBe(400);
  });

  it('returns 404 when project ID does not exist', async () => {
    const res = await request(app.server)
      .post('/v1/projects/00000000-0000-0000-0000-000000000000/deployments')
      .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
      .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
      .expect(404);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.status).toBe(404);
  });

  it('returns 502 when connection fails', async () => {
    mockConnectionCreate.mockRejectedValue(new Error('Invalid access token'));

    const res = await request(app.server)
      .post(`/v1/projects/${projectId}/deployments`)
      .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
      .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
      .expect(502);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.status).toBe(502);
    expect(res.body.title).toBe('Deployment Failed');
  });
});

describe('GET /v1/projects/:id/deployments/:deploymentId', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;
  let deploymentId: string;
  const mockPollStatus = vi.fn();

  beforeAll(async () => {
    const setup = await setupTempProject();
    tmpDir = setup.tmpDir;
    projectId = setup.projectId;
  });

  afterAll(async () => {
    await cleanupTempProject(tmpDir);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createApp();
    await app.ready();

    setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
    setupDeployMock(mockPollStatus);
    mockPollStatus.mockResolvedValue(createSuccessDeployResponse());

    // Initiate deployment
    const deployRes = await request(app.server)
      .post(`/v1/projects/${projectId}/deployments`)
      .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
      .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl);
    deploymentId = deployRes.body.deploymentId;

    // Wait for deployment to complete (async operation)
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('returns 200 with deployment status when deployment is in progress', async () => {
    // Create a new deployment with InProgress mock
    mockPollStatus.mockResolvedValue(createInProgressDeployResponse());

    const deployRes = await request(app.server)
      .post(`/v1/projects/${projectId}/deployments`)
      .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
      .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
      .expect(202);

    const inProgressDeploymentId = deployRes.body.deploymentId;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await request(app.server)
      .get(`/v1/projects/${projectId}/deployments/${inProgressDeploymentId}`)
      .expect(200);

    expect(res.body).toHaveProperty('deploymentId');
    expect(res.body).toHaveProperty('status');
    expect(res.body.status).toBe('InProgress');
  });

  it('returns 200 with full deployment result when deployment succeeds', async () => {
    const res = await request(app.server)
      .get(`/v1/projects/${projectId}/deployments/${deploymentId}`)
      .expect(200);

    expect(res.body.deploymentId).toBe(deploymentId);
    expect(res.body.status).toBe('Succeeded');
    expect(res.body.numberComponentsDeployed).toBe(3);
    expect(res.body.numberComponentsTotal).toBe(3);
    expect(res.body.components).toEqual([
      { fullName: 'Hello_World__c', type: 'CustomObject', state: 'Created' },
      { fullName: 'Hello_World__c.Description__c', type: 'CustomField', state: 'Created' },
      { fullName: 'Hello_World__c.Priority__c', type: 'CustomField', state: 'Created' },
    ]);
  });

  it('returns 200 with error details when deployment fails', async () => {
    // Create a new deployment with Failed mock
    mockPollStatus.mockResolvedValue(createFailedDeployResponse());

    const deployRes = await request(app.server)
      .post(`/v1/projects/${projectId}/deployments`)
      .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
      .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
      .expect(202);

    const failedDeploymentId = deployRes.body.deploymentId;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await request(app.server)
      .get(`/v1/projects/${projectId}/deployments/${failedDeploymentId}`)
      .expect(200);

    expect(res.body.status).toBe('Failed');
    expect(res.body).toHaveProperty('errorMessage');
  });

  it('returns 404 when project ID does not exist', async () => {
    const res = await request(app.server)
      .get(`/v1/projects/00000000-0000-0000-0000-000000000000/deployments/${deploymentId}`)
      .expect(404);

    expect(res.body.status).toBe(404);
  });

  it('returns 404 when deployment ID does not exist', async () => {
    const res = await request(app.server)
      .get(`/v1/projects/${projectId}/deployments/deploy_nonexistent`)
      .expect(404);

    expect(res.body.status).toBe(404);
  });
});

describe('GET /v1/projects/:id/deployments/:deploymentId/events (SSE)', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;
  let deploymentId: string;
  const mockPollStatus = vi.fn();

  beforeAll(async () => {
    const setup = await setupTempProject();
    tmpDir = setup.tmpDir;
    projectId = setup.projectId;
  });

  afterAll(async () => {
    await cleanupTempProject(tmpDir);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createApp();
    await app.ready();

    setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
    setupDeployMock(mockPollStatus);
    mockPollStatus.mockResolvedValue(createSuccessDeployResponse());

    // Initiate deployment
    const deployRes = await request(app.server)
      .post(`/v1/projects/${projectId}/deployments`)
      .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
      .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl);
    deploymentId = deployRes.body.deploymentId;

    // Wait for deployment to complete (async operation)
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('returns 200 with Content-Type: text/event-stream', async () => {
    const res = await request(app.server)
      .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
      .expect(200);

    expect(res.headers['content-type']).toContain('text/event-stream');
  });

  it('returns 200 with Content-Type: text/event-stream', async () => {
    const res = await request(app.server)
      .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
      .expect(200);

    expect(res.headers['content-type']).toContain('text/event-stream');
  });

  it('returns 404 when project ID does not exist', async () => {
    const res = await request(app.server)
      .get(`/v1/projects/00000000-0000-0000-0000-000000000000/deployments/${deploymentId}/events`)
      .expect(404);

    expect(res.body.status).toBe(404);
  });

  it('returns 404 when deployment ID does not exist', async () => {
    const res = await request(app.server)
      .get(`/v1/projects/${projectId}/deployments/deploy_nonexistent/events`)
      .expect(404);

    expect(res.body.status).toBe(404);
  });
});
