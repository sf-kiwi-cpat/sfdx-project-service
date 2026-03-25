/**
 * SPEC TESTS — Human-guarded contract (SDLC 2026)
 *
 * These tests define the contract for:
 * - POST /v1/projects/:id/deployments — initiate deployment
 * - GET /v1/projects/:id/deployments/:deploymentId/events — stream SSE events
 *
 * The contract is async: POST returns 202 Accepted with a deploymentId,
 * then the client streams events via SSE in real-time.
 * There is no polling endpoint — SSE is the single channel for deployment status.
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
