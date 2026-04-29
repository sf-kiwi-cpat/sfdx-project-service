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
 * - GET /v1/projects/:id/deployments/:deploymentId/events — stream SSE events
 *
 * The contract is async: POST returns 202 Accepted with a deploymentId,
 * then the client streams events via SSE in real-time. There is no polling
 * endpoint — SSE is the single channel for deployment status.
 *
 * ## Zero-auth contract
 * The HTTP surface does NOT accept caller-supplied credentials.
 * `Authorization` and `X-Salesforce-Instance-Url` headers are not part of
 * the contract; if sent, they are ignored. Auth is resolved server-side
 * from the CLI environment in this priority order:
 *   1. Request-body `orgAlias` (per-request override)
 *   2. Project target-org (written to `.sf/config.json` at project creation)
 *   3. Global default org (ConfigAggregator `target-org` property)
 *   4. 400 Bad Request
 *
 * ## Staged deploys
 * Templates MAY declare `deployStages` in `template.json` to run multiple
 * manifest-based deploys in order. Templates without `deployStages` use
 * the legacy single-pass `ComponentSet.fromSource(force-app)` behavior.
 * Required stage failure aborts the deploy; optional stage failure emits
 * a warning and continues.
 *
 * These tests are the source of truth for this endpoint's external behavior.
 * The AI implementation agent must NOT modify this file.
 *
 * SDR (source-deploy-retrieve) runs for REAL here — ComponentSet.fromSource()
 * and ComponentSet.fromManifest() actually parse and validate metadata files
 * on disk. Only the network boundary is mocked: @salesforce/core (auth) and
 * ComponentSet.prototype.deploy (Metadata API call).
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';

// Only mock @salesforce/core (auth requires network). SDR runs for real.
const { mockConnectionCreate, mockAuthInfoCreate, mockGetUsername, mockGetPropertyValue } =
  vi.hoisted(() => ({
    mockConnectionCreate: vi.fn(),
    mockAuthInfoCreate: vi.fn(),
    mockGetUsername: vi.fn(),
    mockGetPropertyValue: vi.fn(),
  }));

vi.mock('@salesforce/core', () => ({
  Connection: { create: mockConnectionCreate },
  AuthInfo: { create: mockAuthInfoCreate },
  Global: { SFDX_STATE_FOLDER: '.sfdx' },
  StateAggregator: {
    clearInstance: vi.fn(),
    getInstance: vi.fn().mockResolvedValue({
      aliases: { getUsername: mockGetUsername },
    }),
  },
  ConfigAggregator: {
    create: vi.fn().mockResolvedValue({
      getPropertyValue: mockGetPropertyValue,
    }),
  },
  OrgConfigProperties: { TARGET_ORG: 'target-org' },
}));

import { createApp } from '../../src/app.js';
import {
  COMPONENT_RESPONSES,
  setupTempProject,
  cleanupTempProject,
  setupDefaultMocks,
  setProjectTargetOrg,
  clearProjectTargetOrg,
  createSuccessDeployResponse,
  createSuccessDeployResponseWithoutApp,
  createFailedDeployResponse,
  setupDeployMock,
  setupStagedTemplateProject,
  cleanupStagedTemplateProject,
  TEST_INSTANCE_URL,
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
    // Default: no auth sources configured
    mockGetUsername.mockReturnValue(undefined);
    mockGetPropertyValue.mockReturnValue(undefined);
    await clearProjectTargetOrg(tmpDir, projectId);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe('auth resolution', () => {
    it('returns 202 Accepted when body orgAlias resolves to a username', async () => {
      mockGetUsername.mockImplementation((alias: string) =>
        alias === 'body-alias' ? 'user@body.example.com' : undefined
      );

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'body-alias' })
        .expect(202);

      expect(res.body).toHaveProperty('deploymentId');
      expect(res.body.deploymentId).toMatch(/^deploy_/);
      expect(res.body.status).toBe('Queued');
    });

    it('returns 202 Accepted when project has target-org set (no body)', async () => {
      await setProjectTargetOrg(tmpDir, projectId, 'project-alias');
      mockGetUsername.mockImplementation((alias: string) =>
        alias === 'project-alias' ? 'user@project.example.com' : undefined
      );

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({})
        .expect(202);

      expect(res.body.deploymentId).toMatch(/^deploy_/);
    });

    it('returns 202 Accepted when global default org is configured', async () => {
      mockGetPropertyValue.mockReturnValue('global-alias');
      mockGetUsername.mockImplementation((alias: string) =>
        alias === 'global-alias' ? 'user@global.example.com' : undefined
      );

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({})
        .expect(202);

      expect(res.body.deploymentId).toMatch(/^deploy_/);
    });

    it('prefers body orgAlias over project target-org', async () => {
      await setProjectTargetOrg(tmpDir, projectId, 'project-alias');
      mockGetUsername.mockImplementation((alias: string) => {
        if (alias === 'body-alias') return 'user@body.example.com';
        if (alias === 'project-alias') return 'user@project.example.com';
        return undefined;
      });

      await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'body-alias' })
        .expect(202);

      // Auth was resolved using the body alias (not the project alias)
      expect(mockAuthInfoCreate).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'user@body.example.com' })
      );
    });

    it('prefers project target-org over global default', async () => {
      await setProjectTargetOrg(tmpDir, projectId, 'project-alias');
      mockGetPropertyValue.mockReturnValue('global-alias');
      mockGetUsername.mockImplementation((alias: string) => {
        if (alias === 'project-alias') return 'user@project.example.com';
        if (alias === 'global-alias') return 'user@global.example.com';
        return undefined;
      });

      await request(app.server).post(`/v1/projects/${projectId}/deployments`).send({}).expect(202);

      expect(mockAuthInfoCreate).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'user@project.example.com' })
      );
    });

    it('returns 400 when no auth source is available', async () => {
      // Nothing configured: no body alias, no project target-org, no global default
      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({})
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
      expect(res.body.title).toBe('Bad Request');
      // Error detail must mention how to fix it
      expect(res.body.detail).toMatch(/orgAlias|target-org|default org/i);
    });

    it('returns 400 when body orgAlias does not resolve to a username', async () => {
      mockGetUsername.mockReturnValue(undefined);

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'unknown-alias' })
        .expect(400);

      expect(res.body.status).toBe(400);
      expect(res.body.detail).toMatch(/unknown-alias|not found|not resolved/i);
    });

    it('ignores caller-supplied Authorization headers (zero-auth contract)', async () => {
      // Legacy headers must not satisfy auth — they are dropped/ignored.
      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .set('Authorization', 'Bearer some-stale-token')
        .set('X-Salesforce-Instance-Url', 'https://stale.salesforce.com')
        .send({})
        .expect(400);

      expect(res.body.status).toBe(400);
    });
  });

  describe('basic flow', () => {
    beforeEach(() => {
      mockGetUsername.mockImplementation((alias: string) =>
        alias === 'test-alias' ? 'user@test.example.com' : undefined
      );
    });

    it('returns 404 when project ID does not exist', async () => {
      const res = await request(app.server)
        .post('/v1/projects/00000000-0000-0000-0000-000000000000/deployments')
        .send({ orgAlias: 'test-alias' })
        .expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
    });

    it('returns 502 when connection fails', async () => {
      mockConnectionCreate.mockRejectedValue(new Error('Invalid access token'));

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' })
        .expect(502);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(502);
      expect(res.body.title).toBe('Deployment Failed');
    });
  });
});

describe('GET /v1/projects/:id/deployments/:deploymentId/events (SSE)', () => {
  describe('single-pass deploy (no deployStages)', () => {
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

      mockGetUsername.mockImplementation((alias: string) =>
        alias === 'test-alias' ? 'user@test.example.com' : undefined
      );
      mockConnectionCreate.mockResolvedValue({
        getAuthInfoFields: () => ({ instanceUrl: TEST_INSTANCE_URL }),
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
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

    it('emits a start event carrying the deploymentId', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
        .expect(200);

      const startEvents = parseEventsOfType(res.text, 'start');
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].deploymentId).toBe(deploymentId);
    });

    it('returns Cache-Control: no-cache header for SSE stream', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
        .expect(200);

      expect(res.headers['cache-control']).toBe('no-cache');
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

    it('complete event includes appUrl when deployment contains a WebApplication component', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
        .expect(200);

      const completeData = parseCompleteEvent(res.text);
      expect(completeData).toBeDefined();
      const webAppName = COMPONENT_RESPONSES[3].fullName; // 'App'
      expect(completeData!.appUrl).toBe(`${TEST_INSTANCE_URL}/lwr/application/ai/c-${webAppName}`);
    });

    it('complete event omits appUrl when no WebApplication component is deployed', async () => {
      await app.close();
      vi.clearAllMocks();
      app = createApp();
      await app.ready();

      setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
      setupDeployMock(mockPollStatus);
      mockPollStatus.mockResolvedValue(createSuccessDeployResponseWithoutApp());

      mockGetUsername.mockImplementation((alias: string) =>
        alias === 'test-alias' ? 'user@test.example.com' : undefined
      );
      mockConnectionCreate.mockResolvedValue({
        getAuthInfoFields: () => ({ instanceUrl: TEST_INSTANCE_URL }),
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const noAppDeploymentId = deployRes.body.deploymentId;

      await new Promise((resolve) => setTimeout(resolve, 200));

      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${noAppDeploymentId}/events`)
        .expect(200);

      const completeData = parseCompleteEvent(res.text);
      expect(completeData).toBeDefined();
      expect(completeData!.appUrl).toBeUndefined();
    });

    it('complete event omits appUrl when deployment fails', async () => {
      await app.close();
      vi.clearAllMocks();
      app = createApp();
      await app.ready();

      setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
      setupDeployMock(mockPollStatus);
      mockPollStatus.mockResolvedValue(createFailedDeployResponse());

      mockGetUsername.mockImplementation((alias: string) =>
        alias === 'test-alias' ? 'user@test.example.com' : undefined
      );
      mockConnectionCreate.mockResolvedValue({
        getAuthInfoFields: () => ({ instanceUrl: TEST_INSTANCE_URL }),
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const failedDeploymentId = deployRes.body.deploymentId;

      await new Promise((resolve) => setTimeout(resolve, 200));

      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${failedDeploymentId}/events`)
        .expect(200);

      const completeData = parseCompleteEvent(res.text);
      expect(completeData).toBeDefined();
      expect(completeData!.appUrl).toBeUndefined();
    });
  });

  describe('staged deploy (template with deployStages)', () => {
    let app: ReturnType<typeof createApp>;
    let tmpDir: string;
    let projectId: string;
    const mockPollStatus = vi.fn();

    beforeAll(async () => {
      const setup = await setupStagedTemplateProject({
        stages: [
          { manifest: 'manifest/package.xml' },
          { manifest: 'manifest/flows-package.xml' },
          { manifest: 'manifest/bundle-package.xml', optional: true },
        ],
      });
      tmpDir = setup.tmpDir;
      projectId = setup.projectId;
    });

    afterAll(async () => {
      await cleanupStagedTemplateProject(tmpDir);
    });

    beforeEach(async () => {
      vi.clearAllMocks();
      app = createApp();
      await app.ready();

      setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
      setupDeployMock(mockPollStatus);

      mockGetUsername.mockImplementation((alias: string) =>
        alias === 'test-alias' ? 'user@test.example.com' : undefined
      );
      mockConnectionCreate.mockResolvedValue({
        getAuthInfoFields: () => ({ instanceUrl: TEST_INSTANCE_URL }),
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await app.close();
    });

    it('emits stage events in declared order', async () => {
      mockPollStatus.mockResolvedValue(createSuccessDeployResponseWithoutApp());

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const depId = deployRes.body.deploymentId;

      await new Promise((resolve) => setTimeout(resolve, 400));

      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${depId}/events`)
        .expect(200);

      const stageEvents = parseEventsOfType(res.text, 'stage');
      expect(stageEvents.length).toBe(3);
      expect(stageEvents[0].name).toBe('manifest/package.xml');
      expect(stageEvents[0].index).toBe(0);
      expect(stageEvents[0].total).toBe(3);
      expect(stageEvents[1].name).toBe('manifest/flows-package.xml');
      expect(stageEvents[1].index).toBe(1);
      expect(stageEvents[2].name).toBe('manifest/bundle-package.xml');
      expect(stageEvents[2].index).toBe(2);
    });

    it('complete event includes stages[] summary on success', async () => {
      mockPollStatus.mockResolvedValue(createSuccessDeployResponseWithoutApp());

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const depId = deployRes.body.deploymentId;

      await new Promise((resolve) => setTimeout(resolve, 400));

      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${depId}/events`)
        .expect(200);

      const completeData = parseCompleteEvent(res.text);
      expect(completeData).toBeDefined();
      expect(completeData!.status).toBe('Succeeded');
      expect(Array.isArray(completeData!.stages)).toBe(true);
      expect(completeData!.stages).toHaveLength(3);
      for (const stage of completeData!.stages) {
        expect(stage).toHaveProperty('name');
        expect(stage).toHaveProperty('status');
        expect(stage.status).toBe('Succeeded');
      }
    });

    it('required stage failure aborts remaining stages', async () => {
      // First stage fails; remaining required stage(s) must not run.
      mockPollStatus
        .mockResolvedValueOnce(createFailedDeployResponse())
        .mockResolvedValue(createSuccessDeployResponseWithoutApp());

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const depId = deployRes.body.deploymentId;

      await new Promise((resolve) => setTimeout(resolve, 400));

      // Only the first stage ran (pollStatus called once).
      expect(mockPollStatus).toHaveBeenCalledTimes(1);

      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${depId}/events`)
        .expect(200);

      const completeData = parseCompleteEvent(res.text);
      expect(completeData).toBeDefined();
      expect(completeData!.status).toBe('Failed');
      expect(completeData!.failedStage).toBe('manifest/package.xml');
    });

    it('optional stage failure emits a warning event', async () => {
      // First two required stages succeed; optional third fails.
      mockPollStatus
        .mockResolvedValueOnce(createSuccessDeployResponseWithoutApp())
        .mockResolvedValueOnce(createSuccessDeployResponseWithoutApp())
        .mockResolvedValueOnce(createFailedDeployResponse());

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const depId = deployRes.body.deploymentId;

      await new Promise((resolve) => setTimeout(resolve, 500));

      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${depId}/events`)
        .expect(200);

      const warnings = parseEventsOfType(res.text, 'warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].stage).toBe('manifest/bundle-package.xml');
      expect(warnings[0]).toHaveProperty('errorMessage');
    });

    it('optional stage failure: complete status is SucceededWithWarnings', async () => {
      mockPollStatus
        .mockResolvedValueOnce(createSuccessDeployResponseWithoutApp())
        .mockResolvedValueOnce(createSuccessDeployResponseWithoutApp())
        .mockResolvedValueOnce(createFailedDeployResponse());

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const depId = deployRes.body.deploymentId;

      await new Promise((resolve) => setTimeout(resolve, 500));

      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${depId}/events`)
        .expect(200);

      const completeData = parseCompleteEvent(res.text);
      expect(completeData).toBeDefined();
      expect(completeData!.status).toBe('SucceededWithWarnings');
      expect(Array.isArray(completeData!.warnings)).toBe(true);
      expect(completeData!.warnings).toHaveLength(1);
      expect(completeData!.warnings[0].stage).toBe('manifest/bundle-package.xml');
    });
  });

  // Own describe block with an independent tmpdir so the fixture lifecycle
  // cannot leak into the sibling 'staged deploy' block. The prior structure
  // reassigned `tmpDir` mid-describe, which made `afterAll` ambiguous about
  // which fixture it was cleaning up.
  describe('staged deploy: optional middle stage failure continues', () => {
    let app: ReturnType<typeof createApp>;
    let tmpDir: string;
    let projectId: string;
    const mockPollStatus = vi.fn();

    beforeAll(async () => {
      const setup = await setupStagedTemplateProject({
        stages: [
          { manifest: 'manifest/package.xml' },
          { manifest: 'manifest/flows-package.xml', optional: true },
          { manifest: 'manifest/bundle-package.xml' },
        ],
      });
      tmpDir = setup.tmpDir;
      projectId = setup.projectId;
    });

    afterAll(async () => {
      await cleanupStagedTemplateProject(tmpDir);
    });

    beforeEach(async () => {
      vi.clearAllMocks();
      app = createApp();
      await app.ready();

      setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
      setupDeployMock(mockPollStatus);
      mockGetUsername.mockImplementation((alias: string) =>
        alias === 'test-alias' ? 'user@test.example.com' : undefined
      );
      mockConnectionCreate.mockResolvedValue({
        getAuthInfoFields: () => ({ instanceUrl: TEST_INSTANCE_URL }),
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await app.close();
    });

    it('runs all three stages even when the optional middle stage fails', async () => {
      mockPollStatus
        .mockResolvedValueOnce(createSuccessDeployResponseWithoutApp())
        .mockResolvedValueOnce(createFailedDeployResponse())
        .mockResolvedValueOnce(createSuccessDeployResponseWithoutApp());

      await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });

      await new Promise((resolve) => setTimeout(resolve, 500));

      // All three stages attempted even though the second failed.
      expect(mockPollStatus).toHaveBeenCalledTimes(3);
    });
  });
});

/**
 * Parse the complete event payload from an SSE response body.
 * Returns undefined if no complete event is present.
 */
function parseCompleteEvent(text: string): Record<string, unknown> | undefined {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'event: complete' && lines[i + 1]?.startsWith('data: ')) {
      return JSON.parse(lines[i + 1].slice(6)) as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * Parse all events of a specific type from an SSE response body.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseEventsOfType(text: string, type: string): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === `event: ${type}` && lines[i + 1]?.startsWith('data: ')) {
      out.push(JSON.parse(lines[i + 1].slice(6)));
    }
  }
  return out;
}

// Template deployStages build-time validation is a contract on
// scripts/zip-templates.js, not on the HTTP endpoint. That script is not
// covered by this PR, so no sentinel tests are included here — they gave a
// false sense of coverage. A follow-up PR that touches the build script
// should add a real test that invokes it with a broken fixture and asserts
// a non-zero exit code.
//
// Backwards compatibility for templates without deployStages is already
// covered by the 'single-pass deploy (no deployStages)' describe block
// above.
