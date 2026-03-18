/**
 * SPEC TESTS — Human-guarded contract (SDLC 2026)
 *
 * These tests define the contract for:
 * - POST /v1/projects/:id/deployments with build step integration
 *
 * The build contract is: when a project has package.json with scripts.build,
 * the service must run `npm run build` before deployment.
 *
 * - Build succeeds → deployment proceeds → 200 response with deployment results
 * - Build fails → 502 response with RFC 9457 Problem Details title="Build Failed"
 * - No package.json → skip build → 200 response (deployment only)
 * - Build timeout (5 min) → 502 response with timeout error
 *
 * These tests are the source of truth for the build integration endpoint behavior.
 * The AI implementation agent must NOT modify this file.
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
  createProjectWithPackageJson,
  createProjectWithoutPackageJson,
} from '../deploy/fixtures.js';

describe('POST /v1/projects/:id/deployments with React build step', () => {
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

  describe('project with package.json and build script', () => {
    it('runs build before deployment and succeeds → 202 Accepted', async () => {
      const setup = await createProjectWithPackageJson(tmpDir, 'build-success');
      const testProjectId = setup.projectId;

      const res = await request(app)
        .post(`/v1/projects/${testProjectId}/deployments`)
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .expect(202);

      expect(res.body).toHaveProperty('deploymentId');
      expect(res.body.deploymentId).toMatch(/^deploy_/);
      expect(res.body.status).toBe('Queued');
    });

    it('build fails → 502 Build Failed with RFC 9457 Problem Details', async () => {
      const setup = await createProjectWithPackageJson(tmpDir, 'build-fail');
      const testProjectId = setup.projectId;

      const res = await request(app)
        .post(`/v1/projects/${testProjectId}/deployments`)
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .expect(502);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(502);
      expect(res.body.title).toBe('Build Failed');
      expect(res.body.detail).toContain('npm run build');
    });

    it('build timeout after 5 minutes → 502 Build Timeout', async () => {
      const setup = await createProjectWithPackageJson(tmpDir, 'build-timeout');
      const testProjectId = setup.projectId;

      const res = await request(app)
        .post(`/v1/projects/${testProjectId}/deployments`)
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .expect(502);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(502);
      expect(res.body.title).toBe('Build Failed');
      expect(res.body.detail).toContain('timeout');
    });
  });

  describe('project without package.json', () => {
    it('skips build step → proceeds to deployment → 202 Accepted', async () => {
      const setup = await createProjectWithoutPackageJson(tmpDir);
      const testProjectId = setup.projectId;

      const res = await request(app)
        .post(`/v1/projects/${testProjectId}/deployments`)
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .expect(202);

      expect(res.body).toHaveProperty('deploymentId');
      expect(res.body.deploymentId).toMatch(/^deploy_/);
      expect(res.body.status).toBe('Queued');
    });
  });

  describe('project with package.json but no build script', () => {
    it('skips build step (no scripts.build field) → proceeds to deployment → 202 Accepted', async () => {
      const setup = await createProjectWithPackageJson(tmpDir, 'no-build-script', {
        skipBuildScript: true,
      });
      const testProjectId = setup.projectId;

      const res = await request(app)
        .post(`/v1/projects/${testProjectId}/deployments`)
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .expect(202);

      expect(res.body).toHaveProperty('deploymentId');
      expect(res.body.deploymentId).toMatch(/^deploy_/);
      expect(res.body.status).toBe('Queued');
    });
  });

  describe('error cases', () => {
    it('returns 400 when credentials are missing', async () => {
      const res = await request(app)
        .post(`/v1/projects/${projectId}/deployments`)
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 404 when project ID does not exist', async () => {
      const res = await request(app)
        .post('/v1/projects/00000000-0000-0000-0000-000000000000/deployments')
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .expect(404);

      expect(res.body.status).toBe(404);
    });

    it('returns 502 when Salesforce connection fails', async () => {
      mockConnectionCreate.mockRejectedValue(new Error('Invalid access token'));

      const res = await request(app)
        .post(`/v1/projects/${projectId}/deployments`)
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .expect(502);

      expect(res.body.status).toBe(502);
      expect(res.body.title).toBe('Deployment Failed');
    });
  });
});
