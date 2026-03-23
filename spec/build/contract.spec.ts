/**
 * SPEC TESTS — Human-guarded contract (SDLC 2026)
 *
 * These tests define the contract for:
 * - POST /v1/projects/:id/deployments with Vite programmatic build step
 *
 * The build contract is: when a project contains .tsx or .jsx source files,
 * the service runs vite.build() programmatically before deployment.
 * The service owns the build config — the user's project has no build tooling.
 *
 * - Project has .tsx/.jsx → vite.build() runs → 202 Accepted
 * - Build fails → 502 Build Failed (RFC 9457 Problem Details)
 * - Build times out (5 min) → 502 Build Failed
 * - No .tsx/.jsx files → build skipped → 202 Accepted (metadata-only deploy)
 *
 * Mocking strategy:
 * - @salesforce/core is mocked (auth requires network)
 * - vite module is mocked (controls build outcomes without real compilation)
 * - ComponentSet.prototype.deploy is mocked via setupDeployMock()
 * - Real filesystem for tsx/jsx detection (fixtures create real directories + files)
 *
 * These tests are the source of truth for build integration behavior.
 * The AI implementation agent must NOT modify this file.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';

// Mock @salesforce/core (auth requires network)
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

// Mock vite module — control build() outcomes (success/fail/timeout)
const { mockViteBuild } = vi.hoisted(() => ({
  mockViteBuild: vi.fn(),
}));

vi.mock('vite', () => ({
  build: mockViteBuild,
}));

import { createApp } from '../../src/app.js';
import {
  TEST_CREDENTIALS,
  setupTempProject,
  cleanupTempProject,
  setupDefaultMocks,
  createSuccessDeployResponse,
  setupDeployMock,
} from '../deploy/fixtures.js';
import { createReactProject, createMetadataOnlyProject } from './fixtures.js';

describe('POST /v1/projects/:id/deployments with Vite build step', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let defaultProjectId: string;
  let reactProjectId: string;
  let metadataProjectId: string;
  const mockPollStatus = vi.fn();

  beforeAll(async () => {
    // Create base temp dir and a default project (for error case tests)
    const setup = await setupTempProject();
    tmpDir = setup.tmpDir;
    defaultProjectId = setup.projectId;

    // Create a React project with .tsx files
    const reactSetup = await createReactProject(tmpDir, 'test-app');
    reactProjectId = reactSetup.projectId;

    // Create a metadata-only project (no .tsx/.jsx)
    const metadataSetup = await createMetadataOnlyProject(tmpDir);
    metadataProjectId = metadataSetup.projectId;
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

    // Default: build succeeds
    mockViteBuild.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe('project with .tsx source files', () => {
    it('runs Vite build before deployment and succeeds → 202 Accepted', async () => {
      const res = await request(app.server)
        .post(`/v1/projects/${reactProjectId}/deployments`)
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .expect(202);

      expect(res.body).toHaveProperty('deploymentId');
      expect(res.body.deploymentId).toMatch(/^deploy_/);
      expect(res.body.status).toBe('Queued');
      expect(mockViteBuild).toHaveBeenCalled();
    });

    it('build fails → 502 Build Failed with RFC 9457 Problem Details', async () => {
      mockViteBuild.mockRejectedValue(new Error('Build failed: syntax error in App.tsx'));

      const res = await request(app.server)
        .post(`/v1/projects/${reactProjectId}/deployments`)
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .expect(502);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(502);
      expect(res.body.title).toBe('Build Failed');
    });

    it('build timeout after 5 minutes → 502 Build Failed', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockViteBuild.mockRejectedValue(abortError);

      const res = await request(app.server)
        .post(`/v1/projects/${reactProjectId}/deployments`)
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .expect(502);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(502);
      expect(res.body.title).toBe('Build Failed');
      expect(res.body.detail).toContain('timeout');
    });
  });

  describe('metadata-only project (no .tsx/.jsx files)', () => {
    it('skips build → proceeds to deployment → 202 Accepted', async () => {
      const res = await request(app.server)
        .post(`/v1/projects/${metadataProjectId}/deployments`)
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .expect(202);

      expect(res.body).toHaveProperty('deploymentId');
      expect(res.body.deploymentId).toMatch(/^deploy_/);
      expect(res.body.status).toBe('Queued');
      expect(mockViteBuild).not.toHaveBeenCalled();
    });
  });

  describe('error cases', () => {
    it('returns 400 when credentials are missing', async () => {
      const res = await request(app.server)
        .post(`/v1/projects/${defaultProjectId}/deployments`)
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 404 when project ID does not exist', async () => {
      const res = await request(app.server)
        .post('/v1/projects/00000000-0000-0000-0000-000000000000/deployments')
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .expect(404);

      expect(res.body.status).toBe(404);
    });

    it('returns 502 when Salesforce connection fails', async () => {
      mockConnectionCreate.mockRejectedValue(new Error('Invalid access token'));

      const res = await request(app.server)
        .post(`/v1/projects/${defaultProjectId}/deployments`)
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .expect(502);

      expect(res.body.status).toBe(502);
      expect(res.body.title).toBe('Deployment Failed');
    });
  });
});
