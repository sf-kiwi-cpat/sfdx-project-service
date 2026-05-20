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
 * Contract for per-project unique DeveloperNames on metadata that
 * templates ship singular (UIBundle, CustomApplication, etc.).
 *
 * Background: every built-in template ships its UIBundle under a fixed
 * folder name (`force-app/main/default/uiBundles/App/App.uibundle-meta.xml`),
 * and the data-curator template additionally ships
 * `applications/Data_Curator.app-meta.xml`. Salesforce derives the
 * DeveloperName for each component from the corresponding filename,
 * so every project that deploys data-curator produces a UIBundle named
 * `App` AND a CustomApplication named `Data_Curator`. When two
 * projects deploy to the same Org — common during Blitz testing — the
 * second deploy overwrites the first on both components.
 *
 * This spec defines invariants for per-project unique DeveloperNames so
 * concurrent deploys to a shared org do not collide. The contract is
 * expressed as observable behavior on the project creation + deploy
 * surfaces; the implementation is free to choose any naming strategy
 * (suffix, hash, randomized, template-stamped, etc.) that satisfies the
 * invariants below.
 *
 * The invariants apply generically to *any* metadata file that the
 * template ships under a directory that holds a single component
 * (today: UIBundle and CustomApplication; tomorrow potentially
 * webapplications/, tabs/, etc.). The tests cover UIBundle (every
 * template) and CustomApplication (data-curator, the only template
 * that ships one today).
 *
 * Scope:
 *   - Newly-created projects (POST /v1/projects).
 *   - The build/deploy pipeline's relationship between the on-disk
 *     bundle directory, the deployed UIBundle's `fullName`, and the
 *     returned `appUrl`.
 *   - The on-disk uniqueness of any sibling singular-named metadata
 *     (CustomApplication being today's only other instance).
 *
 * Out of scope:
 *   - The human-readable `<masterLabel>` (stays as the template author
 *     wrote it; not asserted here).
 *   - Migration of pre-existing on-disk projects (treated as
 *     implementation freedom — the contract speaks only to projects
 *     created after this change ships).
 *   - Multi-bundle templates (no template ships more than one UIBundle
 *     today; if/when one does, this contract may need extension).
 *   - Blank projects (POST /v1/projects with no template). They ship
 *     no UIBundle, so no naming invariant applies.
 *
 * Note on idempotency tests: the two idempotency assertions pass
 * vacuously today — today's hardcoded names already don't change
 * between builds. They function as regression guards once the
 * implementation lands, not as contract drivers. Only the uniqueness
 * tests (it.todo) are red against current code.
 *
 * Mock boundary: same as `spec/react-deploy/contract.spec.ts` — vite,
 * @salesforce/core, SDR are mocked. Filesystem and Fastify are real.
 *
 * These tests are the source of truth. The AI implementation agent must
 * NOT modify this file.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';

// Same mock surface as spec/react-deploy.
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
  setupDeployMock,
  createSuccessDeployResponse,
} from '../deploy/fixtures.js';
import { getDeploymentPollPromise } from '../../src/deployments.js';

const TEST_ORG_ALIAS = 'test-alias';
const TEST_USERNAME = 'test-user@example.com';
const UI_BUNDLES_REL_PATH = 'force-app/main/default/uiBundles';
const APPLICATIONS_REL_PATH = 'force-app/main/default/applications';

/**
 * Salesforce DeveloperName format. Starts with a letter, alphanumeric or
 * underscore otherwise, max 80 chars. The name space is intentionally wide
 * — the contract requires uniqueness and validity, not any specific
 * generation strategy.
 */
const DEVELOPER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/**
 * Discover the single UIBundle directory under a project. Tests use this
 * helper so they assert the SHAPE of the path, not a literal value.
 */
async function findBundleDir(projectDir: string): Promise<string> {
  const uiBundlesRoot = path.join(projectDir, UI_BUNDLES_REL_PATH);
  const entries = await fs.readdir(uiBundlesRoot);
  if (entries.length !== 1) {
    throw new Error(
      `Expected exactly one UIBundle directory under ${uiBundlesRoot}, found ${entries.length}: ${entries.join(', ')}`
    );
  }
  return entries[0];
}

/**
 * Discover the (single) CustomApplication file under a project, or
 * undefined if the template ships none. Tests use this helper so they
 * assert the SHAPE of the path, not a literal value.
 */
async function findCustomApplicationName(projectDir: string): Promise<string | undefined> {
  const applicationsRoot = path.join(projectDir, APPLICATIONS_REL_PATH);
  let entries: string[];
  try {
    entries = await fs.readdir(applicationsRoot);
  } catch {
    return undefined;
  }
  const appFiles = entries.filter((e) => e.endsWith('.app-meta.xml'));
  if (appFiles.length === 0) return undefined;
  if (appFiles.length !== 1) {
    throw new Error(
      `Expected at most one CustomApplication under ${applicationsRoot}, found ${appFiles.length}: ${appFiles.join(', ')}`
    );
  }
  return appFiles[0].replace(/\.app-meta\.xml$/, '');
}

describe('per-project unique App (UIBundle) DeveloperName', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  const mockPollStatus = vi.fn();

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

    setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
    setupDeployMock(mockPollStatus);
    mockPollStatus.mockResolvedValue(createSuccessDeployResponse());
    mockViteBuild.mockResolvedValue(undefined);

    mockGetUsername.mockImplementation((alias: string) =>
      alias === TEST_ORG_ALIAS ? TEST_USERNAME : undefined
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe('on-disk bundle name (DeveloperName format)', () => {
    it('a newly-created project has exactly one UIBundle directory', async () => {
      // The contract is single-bundle today — multi-bundle is out of scope.
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'data-curator' })
        .expect(201);

      const projectDir = path.join(tmpDir, res.body.id);
      const uiBundlesRoot = path.join(projectDir, UI_BUNDLES_REL_PATH);
      const entries = await fs.readdir(uiBundlesRoot);

      expect(entries).toHaveLength(1);
    });

    it('the bundle directory name is a valid Salesforce DeveloperName', async () => {
      // Format invariant: alphanumeric+underscore, starts with a letter,
      // max 80 chars. This is the constraint Salesforce enforces server-side.
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'data-curator' })
        .expect(201);

      const projectDir = path.join(tmpDir, res.body.id);
      const bundleName = await findBundleDir(projectDir);

      expect(bundleName).toMatch(DEVELOPER_NAME_PATTERN);
    });

    it('the bundle metadata file is named <bundleName>.uibundle-meta.xml', async () => {
      // The meta filename and the directory name must agree — Salesforce
      // derives `fullName` from the meta filename, and the directory name
      // is what surfaces in error messages.
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'data-curator' })
        .expect(201);

      const projectDir = path.join(tmpDir, res.body.id);
      const bundleName = await findBundleDir(projectDir);
      const bundleDir = path.join(projectDir, UI_BUNDLES_REL_PATH, bundleName);

      const metaFile = path.join(bundleDir, `${bundleName}.uibundle-meta.xml`);
      await expect(fs.stat(metaFile)).resolves.toBeDefined();
    });
  });

  describe('uniqueness across projects', () => {
    // These tests extract the data-curator template twice each (POST
    // /v1/projects → unzip + write hundreds of files), so the default
    // 5s vitest timeout is too tight. 30s gives comfortable headroom on
    // loaded CI without hiding genuine hangs.
    // it.todo until /cdd-implement satisfies it. The assertion body is
    // intact so reviewers can read the intent. Today this fails because
    // every project gets the literal `App` — that's exactly the bug
    // this work fixes. Implementation will switch this back to `it`.
    it.todo(
      'two projects from the same template have different UIBundle DeveloperNames',
      { timeout: 30_000 },
      async () => {
        // The core invariant: same template, different projects, different
        // bundle names. Without this, two App Studio users targeting the same
        // org overwrite each other.
        const a = await request(app.server)
          .post('/v1/projects')
          .send({ template: 'data-curator' })
          .expect(201);
        const b = await request(app.server)
          .post('/v1/projects')
          .send({ template: 'data-curator' })
          .expect(201);

        const nameA = await findBundleDir(path.join(tmpDir, a.body.id));
        const nameB = await findBundleDir(path.join(tmpDir, b.body.id));

        expect(nameA).not.toBe(nameB);
      }
    );

    // it.todo until /cdd-implement satisfies it. Today this fails
    // because every data-curator project gets `Data_Curator`.
    it.todo(
      'two projects from a template that ships a CustomApplication have different CustomApplication names',
      { timeout: 30_000 },
      async () => {
        // A UIBundle-only fix would still leave data-curator's
        // `Data_Curator` CustomApplication colliding on shared orgs. The
        // generalization is "any metadata file the template ships under a
        // directory that holds a single component must be uniquified."
        // CustomApplication is today's instance of that rule beyond UIBundle.
        const a = await request(app.server)
          .post('/v1/projects')
          .send({ template: 'data-curator' })
          .expect(201);
        const b = await request(app.server)
          .post('/v1/projects')
          .send({ template: 'data-curator' })
          .expect(201);

        const appA = await findCustomApplicationName(path.join(tmpDir, a.body.id));
        const appB = await findCustomApplicationName(path.join(tmpDir, b.body.id));

        // data-curator does ship one — assert presence so the test fails
        // loudly if the template ever drops it (which would invalidate the
        // contract this test backs).
        expect(appA).toBeDefined();
        expect(appB).toBeDefined();
        expect(appA).toMatch(DEVELOPER_NAME_PATTERN);
        expect(appB).toMatch(DEVELOPER_NAME_PATTERN);
        expect(appA).not.toBe(appB);
      }
    );

    // Second template ensures the implementation isn't special-cased
    // to data-curator. local-react-test ALSO ships uiBundles/App/, so
    // an implementation that only uniquifies data-curator would pass
    // the test above but still collide for local-react-test users.
    it.todo(
      'two projects from local-react-test have different UIBundle DeveloperNames',
      { timeout: 30_000 },
      async () => {
        const a = await request(app.server)
          .post('/v1/projects')
          .send({ template: 'local-react-test' })
          .expect(201);
        const b = await request(app.server)
          .post('/v1/projects')
          .send({ template: 'local-react-test' })
          .expect(201);

        const nameA = await findBundleDir(path.join(tmpDir, a.body.id));
        const nameB = await findBundleDir(path.join(tmpDir, b.body.id));

        expect(nameA).not.toBe(nameB);
      }
    );
  });

  describe('idempotency for a single project', () => {
    it('rebuilding the same project does not change the UIBundle DeveloperName', async () => {
      // Idempotency invariant: the bundle name is project-stable, not
      // build-time-random. Otherwise every redeploy creates a new orphaned
      // bundle in the org.
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'data-curator' })
        .expect(201);

      const projectDir = path.join(tmpDir, res.body.id);
      const nameBefore = await findBundleDir(projectDir);

      // Trigger a deploy (which runs the build pipeline).
      const deployRes = await request(app.server)
        .post(`/v1/projects/${res.body.id}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS })
        .expect(202);
      await getDeploymentPollPromise(deployRes.body.deploymentId);

      const nameAfter = await findBundleDir(projectDir);
      expect(nameAfter).toBe(nameBefore);
    });

    it('rebuilding the same project does not change the CustomApplication DeveloperName', async () => {
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'data-curator' })
        .expect(201);

      const projectDir = path.join(tmpDir, res.body.id);
      const nameBefore = await findCustomApplicationName(projectDir);
      expect(nameBefore).toBeDefined();

      const deployRes = await request(app.server)
        .post(`/v1/projects/${res.body.id}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS })
        .expect(202);
      await getDeploymentPollPromise(deployRes.body.deploymentId);

      const nameAfter = await findCustomApplicationName(projectDir);
      expect(nameAfter).toBe(nameBefore);
    });
  });

  // appUrl shape is pinned by `spec/deploy/contract.spec.ts` already
  // (`...c-${uiBundle.fullName}`). This spec doesn't re-prove it: the
  // on-disk and uniqueness invariants above transitively constrain what
  // SDR returns and therefore what `appUrl` interpolates.
});
