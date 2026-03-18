/**
 * SPEC TESTS — Human-guarded contract (SDLC 2026)
 *
 * These tests define the contract for POST /projects/:id/deploy.
 * They are the source of truth for this endpoint's external behavior.
 * The AI implementation agent must NOT modify this file.
 *
 * SDR (source-deploy-retrieve) runs for REAL here — ComponentSet.fromSource()
 * actually parses and validates the metadata files on disk.
 * Only the network boundary is mocked: @salesforce/core (auth) and
 * ComponentSet.prototype.deploy (Metadata API call).
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';

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

import { createApp } from '../src/app.js';

const credentials = {
  accessToken: 'test-access-token',
  instanceUrl: 'https://test.salesforce.com',
};

describe('POST /projects/:id/deploy', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;
  const mockPollStatus = vi.fn();

  beforeAll(async () => {
    // Create a temp projects root and a project with real metadata from the hello-world-1 template
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deploy-test-'));
    process.env.PROJECTS_ROOT = tmpDir;
  });

  afterAll(async () => {
    delete process.env.PROJECTS_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createApp();

    // Create a project from the hello-world-1 template
    const createRes = await request(app).post('/projects').send({ template: 'hello-world-1' });
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 with deployment result on success', async () => {
    const res = await request(app)
      .post(`/projects/${projectId}/deploy`)
      .send(credentials)
      .expect(200);

    expect(res.body).toEqual({
      ok: true,
      status: 'Succeeded',
      numberComponentsDeployed: 3,
      numberComponentsTotal: 3,
      components: [
        { fullName: 'Hello_World__c', type: 'CustomObject', state: 'Created' },
        { fullName: 'Hello_World__c.Description__c', type: 'CustomField', state: 'Created' },
        { fullName: 'Hello_World__c.Priority__c', type: 'CustomField', state: 'Created' },
      ],
    });
  });

  it('includes fullName, type, and state for each component', async () => {
    const res = await request(app)
      .post(`/projects/${projectId}/deploy`)
      .send(credentials)
      .expect(200);

    for (const component of res.body.components) {
      expect(component).toHaveProperty('fullName');
      expect(component).toHaveProperty('type');
      expect(component).toHaveProperty('state');
    }
  });

  it('returns 502 with RFC 9457 problem detail when deployment reports failure', async () => {
    mockPollStatus.mockResolvedValue({
      response: {
        status: 'Failed',
        numberComponentsDeployed: 0,
        numberComponentsTotal: 3,
        errorMessage: 'Deployment failed: invalid metadata',
      },
      getFileResponses: () => [],
    });

    const res = await request(app)
      .post(`/projects/${projectId}/deploy`)
      .send(credentials)
      .expect(502);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.status).toBe(502);
    expect(res.body.title).toBe('Deployment Failed');
    expect(res.body.detail).toBeDefined();
    expect(typeof res.body.detail).toBe('string');
  });

  it('returns 502 with RFC 9457 problem detail when connection fails', async () => {
    mockConnectionCreate.mockRejectedValue(new Error('Invalid access token'));

    const res = await request(app)
      .post(`/projects/${projectId}/deploy`)
      .send(credentials)
      .expect(502);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.status).toBe(502);
    expect(res.body.title).toBe('Deployment Failed');
    expect(res.body.detail).toBeDefined();
  });

  it('returns 400 when credentials are missing from the request body', async () => {
    const res = await request(app).post(`/projects/${projectId}/deploy`).send({}).expect(400);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.status).toBe(400);
    expect(res.body.title).toBe('Bad Request');
  });

  it('returns 400 when accessToken is missing', async () => {
    const res = await request(app)
      .post(`/projects/${projectId}/deploy`)
      .send({ instanceUrl: 'https://test.salesforce.com' })
      .expect(400);

    expect(res.body.status).toBe(400);
  });

  it('returns 400 when instanceUrl is missing', async () => {
    const res = await request(app)
      .post(`/projects/${projectId}/deploy`)
      .send({ accessToken: 'some-token' })
      .expect(400);

    expect(res.body.status).toBe(400);
  });

  it('returns 404 when project ID does not exist', async () => {
    const res = await request(app)
      .post('/projects/00000000-0000-0000-0000-000000000000/deploy')
      .send(credentials)
      .expect(404);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.status).toBe(404);
  });
});
