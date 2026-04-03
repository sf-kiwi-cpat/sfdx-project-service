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
 * These tests define the contract for auth simplification (Issue #163):
 *
 * - POST /v1/projects accepts optional orgAlias to configure target-org
 * - POST /v1/projects/:id/deployments resolves auth from the environment
 *   (project target-org → global default → legacy credential headers)
 *
 * Auth resolution priority:
 * 1. Project-level target-org (from .sf/config.json, set via orgAlias at creation)
 * 2. Global default org (from SFDX global config)
 * 3. Legacy credential headers (Authorization + X-Salesforce-Instance-Url)
 * 4. 400 if none available
 *
 * This is backward compatible — existing credential-header auth continues
 * to work as a fallback. The existing deploy specs (spec/deploy/,
 * spec/react-deploy/) test the legacy path and remain valid.
 *
 * Mock boundary: @salesforce/core (auth store, config, connections).
 * Real: filesystem, Fastify HTTP handling, SDR (source-deploy-retrieve).
 *
 * These tests are the source of truth for auth simplification behavior.
 * The AI implementation agent must NOT modify this file.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import path from 'node:path';

// Mock @salesforce/core (auth requires network/real keychain)
const {
  mockConnectionCreate,
  mockAuthInfoCreate,
  mockStateAggregatorGetInstance,
  mockConfigAggregatorCreate,
} = vi.hoisted(() => ({
  mockConnectionCreate: vi.fn(),
  mockAuthInfoCreate: vi.fn(),
  mockStateAggregatorGetInstance: vi.fn(),
  mockConfigAggregatorCreate: vi.fn(),
}));

vi.mock('@salesforce/core', () => ({
  Connection: { create: mockConnectionCreate },
  AuthInfo: { create: mockAuthInfoCreate },
  StateAggregator: {
    clearInstance: vi.fn(),
    getInstance: mockStateAggregatorGetInstance,
  },
  ConfigAggregator: { create: mockConfigAggregatorCreate },
  Global: { SFDX_STATE_FOLDER: '.sfdx' },
  OrgConfigProperties: { TARGET_ORG: 'target-org' },
}));

import { createApp } from '../../src/app.js';
import {
  TEST_ORG_ALIAS,
  TEST_USERNAME,
  setupStateAggregatorMock,
  setupConfigAggregatorMock,
  setupProjectTargetOrg,
  readProjectTargetOrg,
  cleanupProjectConfig,
  setupEnvironmentAuthMocks,
} from './fixtures.js';
import {
  TEST_CREDENTIALS,
  setupTempProject,
  cleanupTempProject,
  createSuccessDeployResponse,
  setupDeployMock,
} from '../deploy/fixtures.js';

describe('POST /v1/projects — orgAlias support', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;

  beforeAll(async () => {
    const setup = await setupTempProject();
    tmpDir = setup.tmpDir;
  });

  afterAll(async () => {
    await cleanupTempProject(tmpDir);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createApp();
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('returns 201 with targetOrg when orgAlias is provided', async () => {
    setupStateAggregatorMock(mockStateAggregatorGetInstance);

    const res = await request(app.server)
      .post('/v1/projects')
      .send({ orgAlias: TEST_ORG_ALIAS })
      .expect(201);

    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('name');
    expect(res.body).toHaveProperty('targetOrg', TEST_ORG_ALIAS);
  });

  it('persists target-org in project .sf/config.json', async () => {
    setupStateAggregatorMock(mockStateAggregatorGetInstance);

    const res = await request(app.server)
      .post('/v1/projects')
      .send({ orgAlias: TEST_ORG_ALIAS })
      .expect(201);

    const projectDir = path.join(tmpDir, res.body.id);
    const targetOrg = await readProjectTargetOrg(projectDir);
    expect(targetOrg).toBe(TEST_ORG_ALIAS);
  });

  it('returns 201 without targetOrg when orgAlias is omitted', async () => {
    const res = await request(app.server).post('/v1/projects').send({}).expect(201);

    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('name');
    expect(res.body).not.toHaveProperty('targetOrg');
  });

  it('returns 400 when orgAlias is not found in auth store', async () => {
    setupStateAggregatorMock(mockStateAggregatorGetInstance, {});

    const res = await request(app.server)
      .post('/v1/projects')
      .send({ orgAlias: 'unknown-alias' })
      .expect(400);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.status).toBe(400);
  });
});

describe('POST /v1/projects/:id/deployments — environment auth', () => {
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

    // Clean project config to ensure tests don't leak state
    await cleanupProjectConfig(path.join(tmpDir, projectId));

    // Default mocks: environment auth succeeds, deployment succeeds
    setupEnvironmentAuthMocks(mockConnectionCreate, mockAuthInfoCreate);
    setupDeployMock(mockPollStatus);
    mockPollStatus.mockResolvedValue(createSuccessDeployResponse());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe('environment auth (new path)', () => {
    it('returns 202 when project has target-org configured', async () => {
      const projectDir = path.join(tmpDir, projectId);
      await setupProjectTargetOrg(projectDir, TEST_ORG_ALIAS);
      setupStateAggregatorMock(mockStateAggregatorGetInstance);

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send()
        .expect(202);

      expect(res.body).toHaveProperty('deploymentId');
      expect(res.body).toHaveProperty('status', 'Queued');
    });

    it('returns 202 using global default org when no target-org', async () => {
      setupConfigAggregatorMock(mockConfigAggregatorCreate, TEST_ORG_ALIAS);
      setupStateAggregatorMock(mockStateAggregatorGetInstance);

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send()
        .expect(202);

      expect(res.body).toHaveProperty('deploymentId');
      expect(res.body).toHaveProperty('status', 'Queued');
    });
  });

  describe('credential headers (legacy fallback)', () => {
    it('returns 202 with credential headers when no environment auth', async () => {
      setupConfigAggregatorMock(mockConfigAggregatorCreate, undefined);

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .expect(202);

      expect(res.body).toHaveProperty('deploymentId');
      expect(res.body).toHaveProperty('status', 'Queued');
    });
  });

  describe('auth resolution priority', () => {
    it('prefers environment auth over credential headers when both present', async () => {
      const projectDir = path.join(tmpDir, projectId);
      await setupProjectTargetOrg(projectDir, TEST_ORG_ALIAS);
      setupStateAggregatorMock(mockStateAggregatorGetInstance);

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
        .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl)
        .send()
        .expect(202);

      expect(res.body).toHaveProperty('deploymentId');
      // Verify environment auth was used (username-based, not accessTokenOptions)
      expect(mockAuthInfoCreate).toHaveBeenCalledWith(
        expect.objectContaining({ username: TEST_USERNAME })
      );
    });
  });

  describe('error cases', () => {
    it('returns 400 when no auth is available (no env, no headers)', async () => {
      setupConfigAggregatorMock(mockConfigAggregatorCreate, undefined);

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send()
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 502 when resolved environment org auth fails', async () => {
      const projectDir = path.join(tmpDir, projectId);
      await setupProjectTargetOrg(projectDir, TEST_ORG_ALIAS);
      setupStateAggregatorMock(mockStateAggregatorGetInstance);

      // Connection creation fails (expired/revoked credentials)
      mockConnectionCreate.mockRejectedValue(new Error('Token expired'));

      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send()
        .expect(502);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(502);
      expect(res.body.title).toBe('Deployment Failed');
    });
  });
});
