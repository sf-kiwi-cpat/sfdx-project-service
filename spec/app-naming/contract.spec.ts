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
 * Renaming a component is not sufficient on its own — other files in the
 * project reference the old DeveloperName and break the deploy unless
 * they are rewritten in lockstep with the rename. This contract pins two
 * such cross-reference invariants:
 *
 *   - CustomApplication references: a PermissionSet/Profile names the app
 *     by DeveloperName inside `<applicationVisibilities><application>`.
 *     Renaming the `.app-meta.xml` file without rewriting these leaves a
 *     dangling reference and the deploy fails with "In field: application
 *     - no CustomApplication named <old> found".
 *   - `.forceignore` bundle globs: templates pin their ignore rules to the
 *     bundle's original path (`uiBundles/<bundle>/...`). After the bundle
 *     dir is renamed, those globs stop matching, so the bundle's
 *     node_modules/src/lockfiles are no longer excluded and get swept into
 *     the UIBundle content payload — exceeding the Metadata API's
 *     39MB / 10,000-file limit ("Content deployment failed for UIBundle").
 *
 * Scope:
 *   - Newly-created projects (POST /v1/projects).
 *   - The build/deploy pipeline's relationship between the on-disk
 *     bundle directory, the deployed UIBundle's `fullName`, and the
 *     returned `appUrl`.
 *   - The on-disk uniqueness of any sibling singular-named metadata
 *     (CustomApplication being today's only other instance).
 *   - The on-disk consistency of cross-references to renamed components:
 *     CustomApplication references in metadata, and `.forceignore` globs
 *     pinned to the bundle directory.
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
 *     no UIBundle, so no naming invariant applies — but the cross-reference
 *     rewrites must be no-ops on them (asserted below).
 *
 * Note on idempotency tests: the two idempotency assertions pass
 * vacuously today — today's hardcoded names already don't change
 * between builds. They function as regression guards once the
 * implementation lands, not as contract drivers.
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
const FORCE_APP_DEFAULT_REL_PATH = 'force-app/main/default';
const FORCEIGNORE_REL_PATH = '.forceignore';

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

/**
 * Collect every `<application>…</application>` reference value found in the
 * project's metadata tree. PermissionSets and Profiles name a
 * CustomApplication by DeveloperName inside `<applicationVisibilities>`;
 * the rename must rewrite these in lockstep with the `.app-meta.xml` file
 * rename or the deploy fails with "no CustomApplication named <old> found".
 *
 * Discovers references by walking `force-app/main/default` (mirroring how
 * the implementation finds them) rather than pinning a literal
 * permissionset path — consistent with the rest of this file's
 * assert-the-shape-not-the-literal style.
 */
async function collectApplicationReferences(projectDir: string): Promise<string[]> {
  const root = path.join(projectDir, FORCE_APP_DEFAULT_REL_PATH);
  const refs: string[] = [];
  async function walk(dir: string): Promise<void> {
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(full);
      } else if (dirent.name.endsWith('.xml')) {
        const xml = await fs.readFile(full, 'utf-8');
        for (const match of xml.matchAll(/<application>([^<]+)<\/application>/g)) {
          refs.push(match[1]);
        }
      }
    }
  }
  await walk(root);
  return refs;
}

/**
 * Extract the bundle-directory segment from every `.forceignore` glob that
 * is scoped to a UIBundle path (`…/uiBundles/<segment>/…`). The capture is
 * delimited by slashes, so it inherently respects the trailing-slash
 * anchoring the rewrite relies on (`App/` ≠ `App_<token>/`). Returns the
 * list of referenced segments — empty if the file pins no bundle globs.
 */
function bundleGlobSegments(forceIgnore: string): string[] {
  return [...forceIgnore.matchAll(/uiBundles\/([^/\n]+)\//g)].map((m) => m[1]);
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
    // Each test here POSTs a fresh project, which extracts the
    // data-curator template (unzip + write hundreds of files). The
    // default 5s vitest timeout is too tight on loaded CI runners;
    // 30s gives headroom without hiding genuine hangs.
    it(
      'a newly-created project has exactly one UIBundle directory',
      { timeout: 30_000 },
      async () => {
        // The contract is single-bundle today — multi-bundle is out of scope.
        const res = await request(app.server)
          .post('/v1/projects')
          .send({ template: 'data-curator' })
          .expect(201);

        const projectDir = path.join(tmpDir, res.body.id);
        const uiBundlesRoot = path.join(projectDir, UI_BUNDLES_REL_PATH);
        const entries = await fs.readdir(uiBundlesRoot);

        expect(entries).toHaveLength(1);
      }
    );

    it(
      'the bundle directory name is a valid Salesforce DeveloperName',
      { timeout: 30_000 },
      async () => {
        // Format invariant: alphanumeric+underscore, starts with a letter,
        // max 80 chars. This is the constraint Salesforce enforces server-side.
        const res = await request(app.server)
          .post('/v1/projects')
          .send({ template: 'data-curator' })
          .expect(201);

        const projectDir = path.join(tmpDir, res.body.id);
        const bundleName = await findBundleDir(projectDir);

        expect(bundleName).toMatch(DEVELOPER_NAME_PATTERN);
      }
    );

    it(
      'the bundle metadata file is named <bundleName>.uibundle-meta.xml',
      { timeout: 30_000 },
      async () => {
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
      }
    );
  });

  describe('uniqueness across projects', () => {
    // These tests extract the data-curator template twice each (POST
    // /v1/projects → unzip + write hundreds of files), so the default
    // 5s vitest timeout is too tight. 30s gives comfortable headroom on
    // loaded CI without hiding genuine hangs.
    it(
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

    it(
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
    it(
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

  describe('cross-reference rewrites that track the rename', () => {
    // Renaming a component (UIBundle dir, CustomApplication file) is not
    // enough: other files reference the OLD DeveloperName and break the
    // deploy unless rewritten in lockstep. These assertions pin the
    // observable on-disk state of a created project — consistent with this
    // file's "assert through the public surface" principle (POST
    // /v1/projects is the surface; the project tree it writes is the
    // observable). The data-curator template is the vehicle: it ships a
    // PermissionSet referencing its CustomApplication AND a `.forceignore`
    // pinned to the bundle path, so a single project creation exercises
    // both rewrites end-to-end.
    //
    // Not covered here, by design: the sibling-name precision guard (a
    // bundle named `App` must not rewrite a sibling `AppExtras`, anchored
    // on the trailing slash). No shipped template provides a sibling bundle
    // to exercise that through the HTTP surface, so it stays a unit test in
    // tests/unit/app-naming.test.ts where the project tree can be staged
    // arbitrarily. The trailing-slash anchoring is still partially
    // exercised below: the bundle segment extraction is slash-delimited, so
    // a stale pre-rename `App/` prefix would surface as a segment mismatch.
    it(
      'rewrites CustomApplication references to the renamed app DeveloperName',
      { timeout: 30_000 },
      async () => {
        // Without this rewrite the deploy fails: "In field: application - no
        // CustomApplication named Data_Curator found". Every
        // `<application>` reference in the tree must name the RENAMED app,
        // not the template's original literal.
        const res = await request(app.server)
          .post('/v1/projects')
          .send({ template: 'data-curator' })
          .expect(201);

        const projectDir = path.join(tmpDir, res.body.id);
        const appName = await findCustomApplicationName(projectDir);
        expect(appName).toBeDefined();

        const refs = await collectApplicationReferences(projectDir);
        // data-curator ships a PermissionSet that references its app, so
        // there is at least one reference to rewrite — assert presence so
        // the test fails loudly if the template ever drops it.
        expect(refs.length).toBeGreaterThan(0);
        // Every reference resolves to the renamed CustomApplication on disk.
        for (const ref of refs) {
          expect(ref).toBe(appName);
        }
      }
    );

    it(
      'rewrites .forceignore bundle globs to the renamed bundle directory',
      { timeout: 30_000 },
      async () => {
        // `.forceignore` rules pinned to `uiBundles/App/**` stop matching
        // once the dir is renamed to `App_<token>`, so node_modules/src get
        // swept into the UIBundle content payload and blow the Metadata
        // API's 39MB / 10,000-file limit ("Content deployment failed for
        // UIBundle"). Every bundle-scoped glob must track the renamed dir.
        const res = await request(app.server)
          .post('/v1/projects')
          .send({ template: 'data-curator' })
          .expect(201);

        const projectDir = path.join(tmpDir, res.body.id);
        const bundleName = await findBundleDir(projectDir);

        const forceIgnore = await fs.readFile(path.join(projectDir, FORCEIGNORE_REL_PATH), 'utf-8');
        const segments = bundleGlobSegments(forceIgnore);
        // data-curator pins ignore rules to its bundle path — assert presence
        // so the test fails loudly if the template stops shipping them.
        expect(segments.length).toBeGreaterThan(0);
        // Every bundle-scoped glob points at the dir that actually exists on
        // disk; no stale pre-rename prefix survives.
        for (const segment of segments) {
          expect(segment).toBe(bundleName);
        }
      }
    );

    it(
      'is a no-op on a blank project (no bundle to rename, no app to rewrite)',
      { timeout: 30_000 },
      async () => {
        // A blank project ships no UIBundle and no CustomApplication, so both
        // cross-reference rewrites must be no-ops: nothing is injected into
        // `.forceignore`, and no `<application>` reference is fabricated.
        const res = await request(app.server).post('/v1/projects').send({}).expect(201);

        const projectDir = path.join(tmpDir, res.body.id);

        // No UIBundle directory exists.
        await expect(fs.readdir(path.join(projectDir, UI_BUNDLES_REL_PATH))).rejects.toThrow();

        // The `.forceignore` carries no bundle-scoped glob — the rewrite had
        // no renamed dir to track and must not invent one.
        const forceIgnore = await fs.readFile(path.join(projectDir, FORCEIGNORE_REL_PATH), 'utf-8');
        expect(bundleGlobSegments(forceIgnore)).toEqual([]);

        // No CustomApplication reference exists to rewrite.
        const refs = await collectApplicationReferences(projectDir);
        expect(refs).toEqual([]);
      }
    );
  });

  describe('idempotency for a single project', () => {
    // Each test extracts data-curator AND runs through the deploy
    // pipeline (mocked SDR + mocked vite, but real fs + Fastify).
    // Same 30s budget rationale as the format/uniqueness blocks.
    it(
      'rebuilding the same project does not change the UIBundle DeveloperName',
      { timeout: 30_000 },
      async () => {
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
      }
    );

    it(
      'rebuilding the same project does not change the CustomApplication DeveloperName',
      { timeout: 30_000 },
      async () => {
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
      }
    );
  });

  // appUrl shape is pinned by `spec/deploy/contract.spec.ts` already
  // (`...c-${uiBundle.fullName}`). This spec doesn't re-prove it: the
  // on-disk and uniqueness invariants above transitively constrain what
  // SDR returns and therefore what `appUrl` interpolates.
});
