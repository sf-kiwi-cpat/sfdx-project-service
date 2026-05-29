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
 * from the CLI environment in this priority order (matching SFDX's own
 * `ConfigAggregator` precedence, which is what `sfdx-agent-sdk`'s
 * `SfCoreOrgAuthResolver.resolveDefault` uses):
 *
 *   1. Request-body `orgAlias` (per-request override, always wins)
 *   2. `SF_TARGET_ORG` / `SFDX_TARGET_ORG` environment variable
 *   3. Project target-org (`.sf/config.json` in the project directory)
 *   4. Global default org (`$HOME/.sf/config.json`)
 *   5. 400 Bad Request
 *
 * Priority chain 2–4 is the built-in order of `ConfigAggregator`'s
 * Location resolution (Environment > Local > Global). Power users who
 * set `SF_TARGET_ORG` in a shell get one-shot org override without
 * mutating project state — same as `sf project deploy start` and
 * `sfdx-agent-service`.
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
 * ## Test strategy: hermetic `HOME` + real `@salesforce/core`
 *
 * Mirrors the pattern in `agentic-dx/packages/sfdx-agent-sdk/test/org-auth-resolver.test.ts`:
 *   - `HOME` redirected to a hermetic temp dir (`beforeAll`/`afterAll`)
 *   - `SF_ENV=test` so `@salesforce/core` uses an in-memory logger
 *   - `@salesforce/core` runs for REAL — `ConfigAggregator` reads real
 *     `.sf/config.json` files on disk and real env vars from `process.env`.
 *     The project target-org fixture `setProjectTargetOrg` writes
 *     `<projectDir>/.sf/config.json`; the global fixture
 *     `setGlobalTargetOrg` writes `$HOME/.sf/config.json`; env-var tests
 *     set `process.env.SF_TARGET_ORG` directly.
 *   - `resolveAlias` (our own function) is mocked at the module boundary
 *     to stub the alias→username lookup without touching the real SFDX
 *     keychain. This mirrors agent-service's `TestResolver` subclass
 *     override pattern, adapted for our function-based codebase.
 *   - `Connection.create`, `AuthInfo.create`, `ComponentSet.prototype.deploy`
 *     remain mocked inline — these hit the network or run real SDR which
 *     is too expensive / network-bound for contract tests.
 *   - Each test clears env vars + `.sf/config.json` files it set, so
 *     tests don't bleed state into each other.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';

// Mock only what must be mocked — network boundary + our alias resolver.
// @salesforce/core's ConfigAggregator runs REAL against hermetic $HOME.
const { mockConnectionCreate, mockAuthInfoCreate, mockResolveAlias } = vi.hoisted(() => ({
  mockConnectionCreate: vi.fn(),
  mockAuthInfoCreate: vi.fn(),
  mockResolveAlias: vi.fn(),
}));

// Spy on Connection.create / AuthInfo.create without displacing the rest
// of @salesforce/core. We use vi.mock with importOriginal so ConfigAggregator,
// StateAggregator.clearInstance, OrgConfigProperties all behave normally.
vi.mock('@salesforce/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@salesforce/core')>();
  return {
    ...original,
    Connection: { ...original.Connection, create: mockConnectionCreate },
    AuthInfo: { ...original.AuthInfo, create: mockAuthInfoCreate },
  };
});

// Mock our own resolveAlias function — stubs the alias→username leaf
// without touching the SFDX keychain. Everything else in auth.ts runs real.
//
// IMPLEMENTATION NOTE (binding on /cdd-implement): for `vi.mock(...)` to
// intercept calls INSIDE `auth.ts` (not just callers outside the module),
// the alias-resolution leaf must live in its OWN module that `auth.ts`
// imports. Equivalent to agent-service's `SfCoreOrgAuthResolver.resolve`
// subclass-override pattern — they extract the credential leaf behind
// an extension boundary; we extract it behind a module boundary.
// Suggested layout: `src/domain/auth/resolve-alias.ts` (export
// `resolveAlias`), `src/domain/auth/index.ts` (imports + re-exports).
// The precise file layout is implementation freedom — only the
// observable test behavior is contractually pinned.
vi.mock('../../src/domain/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/domain/auth.js')>();
  return {
    ...original,
    resolveAlias: mockResolveAlias,
  };
});

import { createApp } from '../../src/app.js';
import {
  COMPONENT_RESPONSES,
  setupTempProject,
  cleanupTempProject,
  setupDefaultMocks,
  setProjectTargetOrg,
  clearProjectTargetOrg,
  setGlobalTargetOrg,
  clearGlobalTargetOrg,
  createSuccessDeployResponse,
  createSuccessDeployResponseWithoutApp,
  createFailedDeployResponse,
  setupDeployMock,
  setupStagedTemplateProject,
  cleanupStagedTemplateProject,
  setupHermeticHome,
  cleanupHermeticHome,
  TEST_INSTANCE_URL,
  EXPECTED_APP_URL_HOST,
} from './fixtures.js';

/**
 * Hermetic-HOME setup shared across every describe block. Each block
 * calls `setupHermeticHome()` in `beforeAll` and `cleanupHermeticHome()`
 * in `afterAll`. Per-test env var / global config cleanup happens in
 * `afterEach` via `clearGlobalTargetOrg` and delete of `SF_TARGET_ORG` /
 * `SFDX_TARGET_ORG`.
 */

describe('POST /v1/projects/:id/deployments', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;
  let hermeticHome: string;
  const mockPollStatus = vi.fn();

  beforeAll(async () => {
    hermeticHome = await setupHermeticHome();
    const setup = await setupTempProject();
    tmpDir = setup.tmpDir;
    projectId = setup.projectId;
  });

  afterAll(async () => {
    await cleanupTempProject(tmpDir);
    await cleanupHermeticHome(hermeticHome);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createApp();
    await app.ready();

    setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
    setupDeployMock(mockPollStatus);
    mockPollStatus.mockResolvedValue(createSuccessDeployResponse());
    // Default: no alias resolves. Individual tests override via
    // mockResolveAlias.mockImplementation(...) to register alias→username.
    mockResolveAlias.mockReturnValue(undefined);
    await clearProjectTargetOrg(tmpDir, projectId);
  });

  afterEach(async () => {
    delete process.env.SF_TARGET_ORG;
    delete process.env.SFDX_TARGET_ORG;
    await clearGlobalTargetOrg(hermeticHome);
    // ConfigAggregator caches; clear between tests so the next beforeEach
    // starts from a truly fresh view of env + disk.
    const { ConfigAggregator } = await import('@salesforce/core');
    await ConfigAggregator.clearInstance();
    vi.restoreAllMocks();
    await app.close();
  });

  describe('auth resolution', () => {
    it('returns 202 Accepted when body orgAlias resolves to a username', async () => {
      mockResolveAlias.mockImplementation((alias: string) =>
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
      mockResolveAlias.mockImplementation((alias: string) =>
        alias === 'project-alias' ? 'user@project.example.com' : undefined
      );

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({})
        .expect(202);

      expect(res.body.deploymentId).toMatch(/^deploy_/);
    });

    it('returns 202 Accepted when global default org is configured', async () => {
      await setGlobalTargetOrg(hermeticHome, 'global-alias');
      mockResolveAlias.mockImplementation((alias: string) =>
        alias === 'global-alias' ? 'user@global.example.com' : undefined
      );

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({})
        .expect(202);

      expect(res.body.deploymentId).toMatch(/^deploy_/);
    });

    it('returns 202 Accepted when SF_TARGET_ORG env var is set', async () => {
      process.env.SF_TARGET_ORG = 'env-alias';
      mockResolveAlias.mockImplementation((alias: string) =>
        alias === 'env-alias' ? 'user@env.example.com' : undefined
      );

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({})
        .expect(202);

      expect(res.body.deploymentId).toMatch(/^deploy_/);
      expect(mockAuthInfoCreate).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'user@env.example.com' })
      );
    });

    it('prefers body orgAlias over project target-org', async () => {
      await setProjectTargetOrg(tmpDir, projectId, 'project-alias');
      mockResolveAlias.mockImplementation((alias: string) => {
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

    it('prefers body orgAlias over SF_TARGET_ORG', async () => {
      // Explicit body override must always win — the caller is saying
      // "for this request, deploy to this alias, regardless of env."
      process.env.SF_TARGET_ORG = 'env-alias';
      mockResolveAlias.mockImplementation((alias: string) => {
        if (alias === 'body-alias') return 'user@body.example.com';
        if (alias === 'env-alias') return 'user@env.example.com';
        return undefined;
      });

      await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'body-alias' })
        .expect(202);

      expect(mockAuthInfoCreate).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'user@body.example.com' })
      );
    });

    it('prefers SF_TARGET_ORG env var over project target-org', async () => {
      // Matches `ConfigAggregator` built-in precedence: env > local > global.
      // Mirrors `sf project deploy start` and agent-service behavior. Lets
      // users override a committed project target-org for one session
      // without mutating project state.
      await setProjectTargetOrg(tmpDir, projectId, 'project-alias');
      process.env.SF_TARGET_ORG = 'env-alias';
      mockResolveAlias.mockImplementation((alias: string) => {
        if (alias === 'env-alias') return 'user@env.example.com';
        if (alias === 'project-alias') return 'user@project.example.com';
        return undefined;
      });

      await request(app.server).post(`/v1/projects/${projectId}/deployments`).send({}).expect(202);

      expect(mockAuthInfoCreate).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'user@env.example.com' })
      );
    });

    it('prefers project target-org over global default', async () => {
      await setProjectTargetOrg(tmpDir, projectId, 'project-alias');
      await setGlobalTargetOrg(hermeticHome, 'global-alias');
      mockResolveAlias.mockImplementation((alias: string) => {
        if (alias === 'project-alias') return 'user@project.example.com';
        if (alias === 'global-alias') return 'user@global.example.com';
        return undefined;
      });

      await request(app.server).post(`/v1/projects/${projectId}/deployments`).send({}).expect(202);

      expect(mockAuthInfoCreate).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'user@project.example.com' })
      );
    });

    it('prefers SF_TARGET_ORG env var over global default', async () => {
      await setGlobalTargetOrg(hermeticHome, 'global-alias');
      process.env.SF_TARGET_ORG = 'env-alias';
      mockResolveAlias.mockImplementation((alias: string) => {
        if (alias === 'env-alias') return 'user@env.example.com';
        if (alias === 'global-alias') return 'user@global.example.com';
        return undefined;
      });

      await request(app.server).post(`/v1/projects/${projectId}/deployments`).send({}).expect(202);

      expect(mockAuthInfoCreate).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'user@env.example.com' })
      );
    });

    it('returns 400 when no auth source is available', async () => {
      // Nothing configured: no body alias, no env var, no project target-org, no global default
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
      mockResolveAlias.mockReturnValue(undefined);

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'unknown-alias' })
        .expect(400);

      expect(res.body.status).toBe(400);
      // Must name the offending alias — generic "alias not resolved" without
      // the value is unhelpful to the caller.
      expect(res.body.detail).toContain('unknown-alias');
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
      mockResolveAlias.mockImplementation((alias: string) =>
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
    let hermeticHome: string;
    const mockPollStatus = vi.fn();

    beforeAll(async () => {
      hermeticHome = await setupHermeticHome();
      const setup = await setupTempProject();
      tmpDir = setup.tmpDir;
      projectId = setup.projectId;
    });

    afterAll(async () => {
      await cleanupTempProject(tmpDir);
      await cleanupHermeticHome(hermeticHome);
    });

    beforeEach(async () => {
      vi.clearAllMocks();
      app = createApp();
      await app.ready();

      setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
      setupDeployMock(mockPollStatus);
      mockPollStatus.mockResolvedValue(createSuccessDeployResponse());

      mockResolveAlias.mockImplementation((alias: string) =>
        alias === 'test-alias' ? 'user@test.example.com' : undefined
      );
      mockConnectionCreate.mockResolvedValue({
        refreshAuth: vi.fn().mockResolvedValue(undefined),
        getAuthInfoFields: () => ({ instanceUrl: TEST_INSTANCE_URL }),
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      deploymentId = deployRes.body.deploymentId;
      // Deployment runs async; tests that need the complete event use
      // streamUntilComplete() to poll. Tests that only assert stream
      // headers do not need to wait.
    });

    afterEach(async () => {
      delete process.env.SF_TARGET_ORG;
      delete process.env.SFDX_TARGET_ORG;
      await clearGlobalTargetOrg(hermeticHome);
      const { ConfigAggregator } = await import('@salesforce/core');
      await ConfigAggregator.clearInstance();
      vi.restoreAllMocks();
      await app.close();
    });

    it('returns 200 with Content-Type: text/event-stream', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
        .set('Accept', 'text/event-stream')
        .expect(200);

      expect(res.headers['content-type']).toContain('text/event-stream');
    });

    it('emits a start event carrying the deploymentId', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
        .set('Accept', 'text/event-stream')
        .expect(200);

      const startEvents = parseEventsOfType(res.text, 'start');
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].deploymentId).toBe(deploymentId);
    });

    it('returns Cache-Control: no-cache header for SSE stream', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
        .set('Accept', 'text/event-stream')
        .expect(200);

      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('returns 404 when project ID does not exist', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/00000000-0000-0000-0000-000000000000/deployments/${deploymentId}/events`)
        .set('Accept', 'text/event-stream')
        .expect(404);

      expect(res.body.status).toBe(404);
    });

    it('returns 404 when deployment ID does not exist', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/deploy_nonexistent/events`)
        .set('Accept', 'text/event-stream')
        .expect(404);

      expect(res.body.status).toBe(404);
    });

    it('returns 400 Bad Request when Accept header is not text/event-stream', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
        .set('Accept', 'application/json')
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('complete event includes appUrl when deployment contains a UIBundle component', async () => {
      // The deploy-toast appUrl is constructed against the canonical
      // "Salesforce App" host (see EXPECTED_APP_URL_HOST docs in fixtures.ts),
      // not the raw instance URL. Cookie-auth REST from the deployed UIBundle
      // is allow-listed only on this host — surfacing the my.salesforce.com
      // host here would 401 on every Connect API call.
      const { complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${deploymentId}/events`
      );
      const webAppName = COMPONENT_RESPONSES[3].fullName; // 'App'
      expect(complete.appUrl).toBe(`${EXPECTED_APP_URL_HOST}/lwr/application/ai/c-${webAppName}`);
    });

    it('complete event omits appUrl when no UIBundle component is deployed', async () => {
      await app.close();
      vi.clearAllMocks();
      app = createApp();
      await app.ready();

      setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
      setupDeployMock(mockPollStatus);
      mockPollStatus.mockResolvedValue(createSuccessDeployResponseWithoutApp());

      mockResolveAlias.mockImplementation((alias: string) =>
        alias === 'test-alias' ? 'user@test.example.com' : undefined
      );
      mockConnectionCreate.mockResolvedValue({
        refreshAuth: vi.fn().mockResolvedValue(undefined),
        getAuthInfoFields: () => ({ instanceUrl: TEST_INSTANCE_URL }),
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const noAppDeploymentId = deployRes.body.deploymentId;

      const { complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${noAppDeploymentId}/events`
      );
      expect(complete.appUrl).toBeUndefined();
    });

    it('complete event omits appUrl when deployment fails', async () => {
      await app.close();
      vi.clearAllMocks();
      app = createApp();
      await app.ready();

      setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
      setupDeployMock(mockPollStatus);
      mockPollStatus.mockResolvedValue(createFailedDeployResponse());

      mockResolveAlias.mockImplementation((alias: string) =>
        alias === 'test-alias' ? 'user@test.example.com' : undefined
      );
      mockConnectionCreate.mockResolvedValue({
        refreshAuth: vi.fn().mockResolvedValue(undefined),
        getAuthInfoFields: () => ({ instanceUrl: TEST_INSTANCE_URL }),
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const failedDeploymentId = deployRes.body.deploymentId;

      const { complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${failedDeploymentId}/events`
      );
      expect(complete.appUrl).toBeUndefined();
    });

    it('appUrl host is rewritten from .salesforce.com to --c.<…>.salesforce.app', async () => {
      // The default test instance URL is `https://test.salesforce.com`. The
      // canonical-domain rewrite must turn it into `https://test--c.salesforce.app`
      // — the host swap is two edits: append `--c` to the leftmost label and
      // change the TLD from `salesforce.com` to `salesforce.app`. This is the
      // shape the deployed UIBundle's cookie-auth REST gets allow-listed for.
      const { complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${deploymentId}/events`
      );
      expect(complete.appUrl).toMatch(/^https:\/\/test--c\.salesforce\.app\//);
      expect(complete.appUrl).not.toMatch(/\.salesforce\.com\//);
    });

    it('appUrl is unmodified when instanceUrl is already on the .salesforce.app domain', async () => {
      // Idempotent shape: an instance URL that already targets the canonical
      // domain (e.g. because core's OrgDnsPublisher has already provisioned
      // it and Connection surfaced that host) is passed through unchanged.
      // No double-`--c`, no TLD flip.
      await app.close();
      vi.clearAllMocks();
      app = createApp();
      await app.ready();
      const alreadyAppDomain = 'https://example--c.my.salesforce.app';

      setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
      setupDeployMock(mockPollStatus);
      mockPollStatus.mockResolvedValue(createSuccessDeployResponse());

      mockResolveAlias.mockImplementation((alias: string) =>
        alias === 'test-alias' ? 'user@test.example.com' : undefined
      );
      mockConnectionCreate.mockResolvedValue({
        refreshAuth: vi.fn().mockResolvedValue(undefined),
        getAuthInfoFields: () => ({ instanceUrl: alreadyAppDomain }),
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const depId = deployRes.body.deploymentId;

      const { complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );
      const webAppName = COMPONENT_RESPONSES[3].fullName; // 'App'
      expect(complete.appUrl).toBe(`${alreadyAppDomain}/lwr/application/ai/c-${webAppName}`);
    });

    it('appUrl falls back to the unmodified instance URL when the host shape is unrecognized', async () => {
      // When the rewrite cannot be applied (e.g. the host doesn't end in
      // `.salesforce.com`/`.salesforce.app` or the leftmost label already
      // carries a `--<ns>` suffix), the contract is to surface the unmodified
      // instance URL rather than a fabricated host. The user gets a working
      // (if 401-prone) URL instead of a non-resolving one.
      await app.close();
      vi.clearAllMocks();
      app = createApp();
      await app.ready();
      const unrecognizedHost = 'https://example.com';

      setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
      setupDeployMock(mockPollStatus);
      mockPollStatus.mockResolvedValue(createSuccessDeployResponse());

      mockResolveAlias.mockImplementation((alias: string) =>
        alias === 'test-alias' ? 'user@test.example.com' : undefined
      );
      mockConnectionCreate.mockResolvedValue({
        refreshAuth: vi.fn().mockResolvedValue(undefined),
        getAuthInfoFields: () => ({ instanceUrl: unrecognizedHost }),
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const depId = deployRes.body.deploymentId;

      const { complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );
      const webAppName = COMPONENT_RESPONSES[3].fullName; // 'App'
      expect(complete.appUrl).toBe(`${unrecognizedHost}/lwr/application/ai/c-${webAppName}`);
    });
  });

  describe('staged deploy (template with deployStages)', () => {
    let app: ReturnType<typeof createApp>;
    let tmpDir: string;
    let projectId: string;
    let hermeticHome: string;
    const mockPollStatus = vi.fn();

    beforeAll(async () => {
      hermeticHome = await setupHermeticHome();
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
      await cleanupHermeticHome(hermeticHome);
    });

    beforeEach(async () => {
      vi.clearAllMocks();
      app = createApp();
      await app.ready();

      setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
      setupDeployMock(mockPollStatus);

      mockResolveAlias.mockImplementation((alias: string) =>
        alias === 'test-alias' ? 'user@test.example.com' : undefined
      );
      mockConnectionCreate.mockResolvedValue({
        refreshAuth: vi.fn().mockResolvedValue(undefined),
        getAuthInfoFields: () => ({ instanceUrl: TEST_INSTANCE_URL }),
      });
    });

    afterEach(async () => {
      delete process.env.SF_TARGET_ORG;
      delete process.env.SFDX_TARGET_ORG;
      await clearGlobalTargetOrg(hermeticHome);
      const { ConfigAggregator } = await import('@salesforce/core');
      await ConfigAggregator.clearInstance();
      vi.restoreAllMocks();
      await app.close();
    });

    it('emits stage events in declared order', async () => {
      mockPollStatus.mockResolvedValue(createSuccessDeployResponseWithoutApp());

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const depId = deployRes.body.deploymentId;

      const { text } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );

      const stageEvents = parseEventsOfType(text, 'stage');
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

      const { complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );
      expect(complete.status).toBe('Succeeded');
      expect(Array.isArray(complete.stages)).toBe(true);
      expect((complete.stages as unknown[]).length).toBe(3);
      for (const stage of complete.stages as Array<Record<string, unknown>>) {
        expect(stage).toHaveProperty('name');
        expect(stage).toHaveProperty('status');
        expect(stage.status).toBe('Succeeded');
      }
    });

    it('complete event sums component counts across stages', async () => {
      // Each successful stage reports 3 components; 3 stages → 9 total.
      mockPollStatus.mockResolvedValue(createSuccessDeployResponseWithoutApp());

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const depId = deployRes.body.deploymentId;

      const { complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );
      expect(complete.numberComponentsDeployed).toBe(9);
      expect(complete.numberComponentsTotal).toBe(9);
      expect(Array.isArray(complete.components)).toBe(true);
      expect((complete.components as unknown[]).length).toBe(9);
    });

    it('complete event includes appUrl when a staged deploy yields a UIBundle', async () => {
      // Last stage's response includes a UIBundle component ("App").
      mockPollStatus
        .mockResolvedValueOnce(createSuccessDeployResponseWithoutApp())
        .mockResolvedValueOnce(createSuccessDeployResponseWithoutApp())
        .mockResolvedValueOnce(createSuccessDeployResponse());

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const depId = deployRes.body.deploymentId;

      const { complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );
      const webAppName = COMPONENT_RESPONSES[3].fullName; // 'App'
      // Same canonical-domain rewrite as the single-pass branch — see
      // EXPECTED_APP_URL_HOST docs in fixtures.ts.
      expect(complete.appUrl).toBe(`${EXPECTED_APP_URL_HOST}/lwr/application/ai/c-${webAppName}`);
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

      const { complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );

      // Only the first stage ran (pollStatus called once).
      expect(mockPollStatus).toHaveBeenCalledTimes(1);
      expect(complete.status).toBe('Failed');
      expect(complete.failedStage).toBe('manifest/package.xml');
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

      const { text } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );

      const warnings = parseEventsOfType(text, 'warning');
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

      const { complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );
      expect(complete.status).toBe('SucceededWithWarnings');
      expect(Array.isArray(complete.warnings)).toBe(true);
      const warnings = complete.warnings as Array<Record<string, unknown>>;
      expect(warnings).toHaveLength(1);
      expect(warnings[0].stage).toBe('manifest/bundle-package.xml');
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
    let hermeticHome: string;
    const mockPollStatus = vi.fn();

    beforeAll(async () => {
      hermeticHome = await setupHermeticHome();
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
      await cleanupHermeticHome(hermeticHome);
    });

    beforeEach(async () => {
      vi.clearAllMocks();
      app = createApp();
      await app.ready();

      setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
      setupDeployMock(mockPollStatus);
      mockResolveAlias.mockImplementation((alias: string) =>
        alias === 'test-alias' ? 'user@test.example.com' : undefined
      );
      mockConnectionCreate.mockResolvedValue({
        refreshAuth: vi.fn().mockResolvedValue(undefined),
        getAuthInfoFields: () => ({ instanceUrl: TEST_INSTANCE_URL }),
      });
    });

    afterEach(async () => {
      delete process.env.SF_TARGET_ORG;
      delete process.env.SFDX_TARGET_ORG;
      await clearGlobalTargetOrg(hermeticHome);
      const { ConfigAggregator } = await import('@salesforce/core');
      await ConfigAggregator.clearInstance();
      vi.restoreAllMocks();
      await app.close();
    });

    it('runs all three stages even when the optional middle stage fails', async () => {
      mockPollStatus
        .mockResolvedValueOnce(createSuccessDeployResponseWithoutApp())
        .mockResolvedValueOnce(createFailedDeployResponse())
        .mockResolvedValueOnce(createSuccessDeployResponseWithoutApp());

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' });
      const depId = deployRes.body.deploymentId;

      // Wait for the deploy to finish (complete event appears) — polling
      // instead of a fixed sleep keeps this robust to CI latency.
      await streamUntilComplete(app, `/v1/projects/${projectId}/deployments/${depId}/events`);

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

/**
 * Fetch the SSE stream and return the parsed complete-event payload.
 * Polls up to `timeoutMs` waiting for the complete event to appear, then
 * returns the full SSE body for the caller's own parsing needs plus the
 * parsed complete event.
 *
 * Replaces hardcoded `setTimeout(... , N)` waits in tests: the assertion
 * is "the deploy eventually completes", not "within Nms", so it is robust
 * to loaded CI without over-budgeting fast machines.
 */
async function streamUntilComplete(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  url: string,
  timeoutMs = 5000
): Promise<{ text: string; complete: Record<string, unknown> }> {
  const start = Date.now();
  let lastText = '';
  while (Date.now() - start < timeoutMs) {
    const res = await request(app.server).get(url).set('Accept', 'text/event-stream').expect(200);
    lastText = res.text;
    const complete = parseCompleteEvent(res.text);
    if (complete) {
      return { text: res.text, complete };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `streamUntilComplete: no complete event within ${timeoutMs}ms. Last body:\n${lastText}`
  );
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
