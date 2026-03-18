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

    setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
    setupDeployMock(mockPollStatus);
    mockPollStatus.mockResolvedValue(createSuccessDeployResponse());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 202 Accepted with deploymentId and initial status', async () => {
    const res = await request(app)
      .post(`/v1/projects/${projectId}/deployments`)
      .send(TEST_CREDENTIALS)
      .expect(202);

    expect(res.body).toHaveProperty('deploymentId');
    expect(res.body).toHaveProperty('status');
    expect(typeof res.body.deploymentId).toBe('string');
    expect(res.body.deploymentId).toMatch(/^deploy_/);
  });

  it('returns 400 when credentials are missing', async () => {
    const res = await request(app)
      .post(`/v1/projects/${projectId}/deployments`)
      .send({})
      .expect(400);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.status).toBe(400);
    expect(res.body.title).toBe('Bad Request');
  });

  it('returns 400 when accessToken is missing', async () => {
    const res = await request(app)
      .post(`/v1/projects/${projectId}/deployments`)
      .send({ instanceUrl: 'https://test.salesforce.com' })
      .expect(400);

    expect(res.body.status).toBe(400);
  });

  it('returns 400 when instanceUrl is missing', async () => {
    const res = await request(app)
      .post(`/v1/projects/${projectId}/deployments`)
      .send({ accessToken: 'some-token' })
      .expect(400);

    expect(res.body.status).toBe(400);
  });

  it('returns 400 when instanceUrl is not a valid URL', async () => {
    const res = await request(app)
      .post(`/v1/projects/${projectId}/deployments`)
      .send({ accessToken: 'token', instanceUrl: 'not-a-url' })
      .expect(400);

    expect(res.body.status).toBe(400);
  });

  it('returns 404 when project ID does not exist', async () => {
    const res = await request(app)
      .post('/v1/projects/00000000-0000-0000-0000-000000000000/deployments')
      .send(TEST_CREDENTIALS)
      .expect(404);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.status).toBe(404);
  });

  it('returns 502 when connection fails', async () => {
    mockConnectionCreate.mockRejectedValue(new Error('Invalid access token'));

    const res = await request(app)
      .post(`/v1/projects/${projectId}/deployments`)
      .send(TEST_CREDENTIALS)
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

    setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
    setupDeployMock(mockPollStatus);
    mockPollStatus.mockResolvedValue(createSuccessDeployResponse());

    // Initiate deployment
    const deployRes = await request(app)
      .post(`/v1/projects/${projectId}/deployments`)
      .send(TEST_CREDENTIALS);
    deploymentId = deployRes.body.deploymentId;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 with deployment status when deployment is in progress', async () => {
    mockPollStatus.mockResolvedValue(createInProgressDeployResponse());

    const res = await request(app)
      .get(`/v1/projects/${projectId}/deployments/${deploymentId}`)
      .expect(200);

    expect(res.body).toHaveProperty('deploymentId');
    expect(res.body).toHaveProperty('status');
    expect(res.body.status).toBe('InProgress');
  });

  it('returns 200 with full deployment result when deployment succeeds', async () => {
    const res = await request(app)
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
    mockPollStatus.mockResolvedValue(createFailedDeployResponse());

    const res = await request(app)
      .get(`/v1/projects/${projectId}/deployments/${deploymentId}`)
      .expect(200);

    expect(res.body.status).toBe('Failed');
    expect(res.body).toHaveProperty('errorMessage');
  });

  it('returns 404 when project ID does not exist', async () => {
    const res = await request(app)
      .get(`/v1/projects/00000000-0000-0000-0000-000000000000/deployments/${deploymentId}`)
      .expect(404);

    expect(res.body.status).toBe(404);
  });

  it('returns 404 when deployment ID does not exist', async () => {
    const res = await request(app)
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

    setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
    setupDeployMock(mockPollStatus);
    mockPollStatus.mockResolvedValue(createSuccessDeployResponse());

    // Initiate deployment
    const deployRes = await request(app)
      .post(`/v1/projects/${projectId}/deployments`)
      .send(TEST_CREDENTIALS);
    deploymentId = deployRes.body.deploymentId;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 with Content-Type: text/event-stream', async () => {
    const res = await request(app)
      .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
      .expect(200);

    expect(res.headers['content-type']).toContain('text/event-stream');
  });

  it('streams SSE events with full SDR deployment data', (done) => {
    const res = request(app).get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`);

    let eventCount = 0;
    const events: Array<{ type: string; data: string }> = [];

    res.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      // Parse simple SSE format: "event: type\ndata: {...}\n\n"
      const lines = text.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].startsWith('event:')) {
          const eventType = lines[i].substring(6).trim();
          const dataLine = lines[i + 1];
          if (dataLine?.startsWith('data:')) {
            const eventData = dataLine.substring(5).trim();
            events.push({ type: eventType, data: eventData });
            eventCount++;
          }
        }
      }
    });

    res.on('end', () => {
      expect(eventCount).toBeGreaterThan(0);
      // At minimum, should have events from the deployment lifecycle
      expect(events.some((e) => e.type === 'start' || e.type === 'complete')).toBe(true);
      done();
    });

    res.end();
  });

  it('includes component-level details in SSE events when available', (done) => {
    const res = request(app).get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`);

    let hasComponentDetails = false;

    res.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      // Check if events contain component information from SDR
      if (text.includes('Hello_World__c') || text.includes('CustomObject')) {
        hasComponentDetails = true;
      }
    });

    res.on('end', () => {
      expect(hasComponentDetails).toBe(true);
      done();
    });

    res.end();
  });

  it('returns 404 when project ID does not exist', async () => {
    const res = await request(app)
      .get(`/v1/projects/00000000-0000-0000-0000-000000000000/deployments/${deploymentId}/events`)
      .expect(404);

    expect(res.body.status).toBe(404);
  });

  it('returns 404 when deployment ID does not exist', async () => {
    const res = await request(app)
      .get(`/v1/projects/${projectId}/deployments/deploy_nonexistent/events`)
      .expect(404);

    expect(res.body.status).toBe(404);
  });
});
