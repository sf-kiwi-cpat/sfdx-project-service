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
 * Contract for the Vite build step layered on top of
 * `POST /v1/projects/:id/deployments`. When a project contains `.tsx` or
 * `.jsx` source files, the service runs `vite.build()` before proceeding
 * with metadata deployment. This spec asserts build-step behavior only —
 * the deploy endpoint's auth contract is defined in
 * `spec/deploy/contract.spec.ts`.
 *
 * Auth for these tests is resolved via the zero-auth contract: the body
 * carries `{ orgAlias: 'test-alias' }` and `StateAggregator` is mocked to
 * resolve that alias to a test username. No `Authorization` /
 * `X-Salesforce-Instance-Url` headers are sent — those are not part of
 * the HTTP contract.
 *
 * Mock boundary: @salesforce/core (auth) and vite (build). Real: Fastify,
 * filesystem, deployment store, SDR.
 *
 * These tests are the source of truth for the Vite build-step contract.
 * The AI implementation agent must NOT modify this file.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';

// Mock @salesforce/core (auth requires network / real keychain)
const { mockConnectionCreate, mockAuthInfoCreate, mockGetUsername } = vi.hoisted(() => ({
  mockConnectionCreate: vi.fn(),
  mockAuthInfoCreate: vi.fn(),
  mockGetUsername: vi.fn(),
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
      getPropertyValue: vi.fn().mockReturnValue(undefined),
    }),
  },
  OrgConfigProperties: { TARGET_ORG: 'target-org' },
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
  setupTempProject,
  cleanupTempProject,
  setupDefaultMocks,
  createSuccessDeployResponse,
  setupDeployMock,
} from '../deploy/fixtures.js';
import { getDeploymentPollPromise, getDeployment } from '../../src/deployments.js';
import { createReactProject, createMetadataOnlyProject } from './fixtures.js';

const TEST_ORG_ALIAS = 'test-alias';
const TEST_USERNAME = 'test-user@example.com';

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

    // Default: TEST_ORG_ALIAS resolves to a known username. Individual tests
    // can override mockGetUsername to simulate unresolvable aliases.
    mockGetUsername.mockImplementation((alias: string) =>
      alias === TEST_ORG_ALIAS ? TEST_USERNAME : undefined
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe('project with .tsx source files', () => {
    it('returns 202 immediately and runs Vite build asynchronously', async () => {
      const res = await request(app.server)
        .post(`/v1/projects/${reactProjectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS })
        .expect(202);

      expect(res.body).toHaveProperty('deploymentId');
      expect(res.body.deploymentId).toMatch(/^deploy_/);
      expect(res.body.status).toBe('Queued');

      // Wait for async pipeline to complete, then verify build ran with
      // outDir pointing at the project's UIBundle dist/ directory.
      // The bundle directory name is implementation freedom (see
      // spec/app-naming) — assert SHAPE, not literal value.
      const { deploymentId } = res.body;
      await getDeploymentPollPromise(deploymentId);
      expect(mockViteBuild).toHaveBeenCalledWith(
        expect.objectContaining({
          build: expect.objectContaining({
            outDir: expect.stringMatching(
              /force-app\/main\/default\/uiBundles\/[A-Za-z][A-Za-z0-9_]{0,79}\/dist$/
            ),
          }),
        })
      );
    });

    it('build fails → 202 Accepted, deployment result contains build error', async () => {
      mockViteBuild.mockRejectedValue(new Error('Build failed: syntax error in App.tsx'));

      const res = await request(app.server)
        .post(`/v1/projects/${reactProjectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS })
        .expect(202);

      // Wait for async pipeline to complete
      const { deploymentId } = res.body;
      await getDeploymentPollPromise(deploymentId);

      const deployment = getDeployment(deploymentId);
      expect(deployment?.error).toContain('Build failed');
    });

    it('build timeout → 202 Accepted, deployment result contains timeout error', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockViteBuild.mockRejectedValue(abortError);

      const res = await request(app.server)
        .post(`/v1/projects/${reactProjectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS })
        .expect(202);

      // Wait for async pipeline to complete
      const { deploymentId } = res.body;
      await getDeploymentPollPromise(deploymentId);

      const deployment = getDeployment(deploymentId);
      expect(deployment?.error).toContain('timeout');
    });
  });

  describe('metadata-only project (no .tsx/.jsx files)', () => {
    it('skips build → proceeds to deployment → 202 Accepted', async () => {
      const res = await request(app.server)
        .post(`/v1/projects/${metadataProjectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS })
        .expect(202);

      expect(res.body).toHaveProperty('deploymentId');
      expect(res.body.deploymentId).toMatch(/^deploy_/);
      expect(res.body.status).toBe('Queued');
      expect(mockViteBuild).not.toHaveBeenCalled();
    });
  });

  describe('error cases', () => {
    it('returns 404 when project ID does not exist', async () => {
      const res = await request(app.server)
        .post('/v1/projects/00000000-0000-0000-0000-000000000000/deployments')
        .send({ orgAlias: TEST_ORG_ALIAS })
        .expect(404);

      expect(res.body.status).toBe(404);
    });

    it('returns 502 when Salesforce connection fails', async () => {
      mockConnectionCreate.mockRejectedValue(new Error('Invalid access token'));

      const res = await request(app.server)
        .post(`/v1/projects/${defaultProjectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS })
        .expect(502);

      expect(res.body.status).toBe(502);
      expect(res.body.title).toBe('Deployment Failed');
    });
  });
});
