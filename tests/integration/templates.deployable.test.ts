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
 * Tier 1 template deployability check.
 *
 * For every template under `templates/src/*`, this suite drives the
 * full non-SDR-deploy pipeline end-to-end: real `POST /v1/projects`
 * unzip path → real `readDeployStages` parse → real `runViteBuild`
 * (no Vite mock) → real SDR `ComponentSet` discovery over the
 * extracted output. The only thing we stop short of is
 * `ComponentSet.deploy` itself — that belongs to the opt-in Tier 3
 * live-deploy suite at `tests/live/`.
 *
 * What it catches:
 *   • Case-sensitivity regressions on the `.uibundle-meta.xml` suffix
 *     (silently passes on macOS, breaks on Linux/SDR)
 *   • Vite/rolldown path bugs (the class of regression that was
 *     originally masked by `vi.mock('vite')`)
 *   • Manifest entries that reference files that were never shipped
 *     in the template content
 *   • New templates added to `templates/src/` that break out of the box
 *   • API-version floors falling below UIBundle's 66.0 minimum
 *
 * Auto-discovery: there is NO hardcoded list of templates. Any new
 * template under `templates/src/` is picked up automatically and must
 * satisfy the full contract.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { createApp } from '../../src/app.js';
import { hasReactFiles, runViteBuild } from '../../src/domain/build.js';
import { readDeployStages } from '../../src/domain/deploy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_SRC = path.resolve(__dirname, '../../templates/src');

async function discoverTemplates(): Promise<string[]> {
  const entries = await fs.readdir(TEMPLATES_SRC, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

describe('tier-1: every template is deployable (structurally)', async () => {
  const templates = await discoverTemplates();
  // Fail loudly if discovery returns empty — catches a misconfigured
  // template root rather than silently declaring success on zero tests.
  expect(templates.length, 'expected at least one template under templates/src/').toBeGreaterThan(
    0
  );

  let tmpRoot: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-tier1-'));
    process.env.PROJECTS_ROOT = tmpRoot;
    app = createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.PROJECTS_ROOT;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  describe.each(templates)('%s', (templateId) => {
    let projectId: string;
    let projectDir: string;

    // 30s timeout: generous headroom under quality-suite load so a slow
    // create can't cascade-fail every dependent test in the same
    // describe.each block. (Extraction itself is fast — ~455 files for
    // data-curator — but the suite shares CI runners.)
    it('creates a project via POST /v1/projects', async () => {
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: templateId })
        .expect(201);
      projectId = res.body.id as string;
      projectDir = path.join(tmpRoot, projectId);
      expect(projectId).toBeDefined();
    }, 30_000);

    it('sfdx-project.json pins API version >= 66.0', async () => {
      const raw = await fs.readFile(path.join(projectDir, 'sfdx-project.json'), 'utf-8');
      const cfg = JSON.parse(raw) as { sourceApiVersion?: string };
      expect(cfg.sourceApiVersion, 'sourceApiVersion must be declared').toBeDefined();
      const v = parseFloat(cfg.sourceApiVersion as string);
      expect(v, 'UIBundle requires API 66.0+').toBeGreaterThanOrEqual(66.0);
    });

    it('ships <bundleName>.uibundle-meta.xml with canonical lowercase suffix', async () => {
      const bundlesRoot = path.join(projectDir, 'force-app/main/default/uiBundles');
      const bundleEntries = await fs.readdir(bundlesRoot);
      expect(bundleEntries).toHaveLength(1);
      const bundleName = bundleEntries[0];
      const dir = path.join(bundlesRoot, bundleName);
      const entries = await fs.readdir(dir);
      expect(entries).toContain(`${bundleName}.uibundle-meta.xml`);
      // Belt-and-suspenders: make sure the mixed-case form is gone —
      // it'd silently succeed on macOS and fail on Linux / SDR's server.
      expect(entries).not.toContain(`${bundleName}.uiBundle-meta.xml`);
    });

    it('readDeployStages parses cleanly (returns undefined or valid stages)', async () => {
      // readDeployStages now throws BuildError on malformed input, so a
      // successful call proves the template.json (if present) is valid.
      const stages = await readDeployStages(projectDir);
      if (stages !== undefined) {
        expect(stages.length, 'declared stages must not be empty').toBeGreaterThan(0);
        // Every declared manifest must exist on disk in the extracted project.
        for (const stage of stages) {
          const manifestPath = path.join(projectDir, stage.manifest);
          await expect(
            fs.stat(manifestPath),
            `manifest ${stage.manifest} must exist`
          ).resolves.toBeDefined();
        }
      }
    });

    it('real Vite build succeeds (no mock) within perf budget', async () => {
      const reactDetected = await hasReactFiles(projectDir);
      if (!reactDetected) return;

      const start = Date.now();
      await runViteBuild(projectDir);
      const elapsed = Date.now() - start;

      const bundlesRoot = path.join(projectDir, 'force-app/main/default/uiBundles');
      const bundleEntries = await fs.readdir(bundlesRoot);
      const distDir = path.join(bundlesRoot, bundleEntries[0], 'dist');
      const indexHtml = path.join(distDir, 'index.html');
      await expect(fs.stat(indexHtml)).resolves.toBeDefined();

      const assets = await fs.readdir(path.join(distDir, 'assets'));
      const hasJs = assets.some((f) => f.endsWith('.js'));
      expect(hasJs, 'Vite should emit at least one hashed .js bundle').toBe(true);

      // Perf budget — our 220KB data-curator app builds in ~300ms; 10s
      // is a wildly generous ceiling that still catches pathological
      // regressions (e.g. someone accidentally disables
      // `configFile: false` and the template's config stalls the build).
      expect(elapsed, `Vite build took ${elapsed}ms`).toBeLessThan(10_000);
    }, 30_000);

    it('SDR ComponentSet discovers the expected components', async () => {
      const stages = await readDeployStages(projectDir);

      const allComponents: Array<{ type: string; fullName: string; xml?: string }> = [];
      if (stages !== undefined) {
        // Staged template — each stage's manifest must resolve to a
        // non-empty ComponentSet over the extracted project.
        for (const stage of stages) {
          const manifestPath = path.join(projectDir, stage.manifest);
          const cs = await ComponentSet.fromManifest({
            manifestPath,
            resolveSourcePaths: [projectDir],
          });
          expect(cs.size, `stage ${stage.manifest} resolved 0 components`).toBeGreaterThan(0);
          for (const c of cs) {
            allComponents.push({ type: c.type.name, fullName: c.fullName, xml: c.xml });
          }
        }
      } else {
        // Single-pass template — ComponentSet.fromSource over force-app.
        const cs = ComponentSet.fromSource(path.join(projectDir, 'force-app'));
        expect(cs.size, 'single-pass template resolved 0 components').toBeGreaterThan(0);
        for (const c of cs) {
          allComponents.push({ type: c.type.name, fullName: c.fullName, xml: c.xml });
        }
      }

      // Every template under our built-in set ships a UIBundle — if
      // that ever changes, this assertion should be relaxed per-template.
      const uiBundles = allComponents.filter((c) => c.type === 'UIBundle');
      expect(uiBundles.length, 'every built-in template ships a UIBundle').toBeGreaterThan(0);

      // Walk each top-level component's content and make sure every
      // path the ComponentSet claims actually exists on disk. Catches
      // orphan manifest entries.
      //
      // Child components (CustomField inside CustomObject, ListView,
      // WebLink, etc.) don't expose walkContent() — their files are
      // covered by the parent's walk. We filter to parent components
      // by checking the method exists.
      const allSeen = new Set<string>();
      const walkAll = (cs: ComponentSet): void => {
        for (const c of cs) {
          if (typeof c.walkContent !== 'function') continue;
          for (const file of c.walkContent()) {
            allSeen.add(file);
          }
        }
      };
      if (stages !== undefined) {
        for (const stage of stages) {
          const manifestPath = path.join(projectDir, stage.manifest);
          const cs = await ComponentSet.fromManifest({
            manifestPath,
            resolveSourcePaths: [projectDir],
          });
          walkAll(cs);
        }
      } else {
        walkAll(ComponentSet.fromSource(path.join(projectDir, 'force-app')));
      }

      for (const file of allSeen) {
        await expect(fs.stat(file), `walked content ${file} must exist`).resolves.toBeDefined();
      }
    }, 30_000);
  });
});

/**
 * Template packaging invariants.
 *
 * The build (`scripts/zip-templates.js`, run by `pretest:integration`) ships
 * only the files a created project needs at runtime: it installs production
 * dependencies (`npm ci --omit=dev`) and keeps any node_modules it did not
 * itself install out of content.zip. The build & preview servers resolve
 * their Vite toolchain from their own node_modules, never the project's, so
 * shipping the dev toolchain per project is pure dead weight (it dominated
 * extraction time — data-curator was 15,519 files, ~99% node_modules).
 *
 * These tests assert the post-extraction project tree, the surface the
 * runtime actually sees:
 *   • No dev-toolchain packages (typescript, vite, esbuild, …) under any
 *     node_modules — only production deps ship.
 *   • No unmanaged node_modules: a node_modules dir may exist only where a
 *     sibling package.json does (the build installs only next to one).
 *   • The runtime deps the app imports (react) are present.
 */
describe('tier-1: template packaging is slim', async () => {
  const templates = await discoverTemplates();

  let tmpRoot: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-tier1-pkg-'));
    process.env.PROJECTS_ROOT = tmpRoot;
    app = createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.PROJECTS_ROOT;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  // Dev-only packages that must never appear in a shipped node_modules.
  // Their presence means a `--omit=dev` install regressed to a full one.
  // @salesforce/vite-plugin-ui-bundle is the most likely accidental leak —
  // it lives in devDependencies but sounds runtime-ish; the build/preview
  // servers resolve it from their own node_modules, never the project's.
  const DEV_TOOLCHAIN = [
    'typescript',
    'vite',
    'esbuild',
    'rollup',
    '@vitejs',
    '@babel',
    '@salesforce/vite-plugin-ui-bundle',
  ];

  /** Recursively collect every node_modules directory under `root`. */
  async function findNodeModulesDirs(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Awaited<ReturnType<typeof fs.readdir>>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true } as never);
      } catch {
        return;
      }
      for (const e of entries as unknown as Array<{ name: string; isDirectory(): boolean }>) {
        if (!e.isDirectory()) continue;
        const abs = path.join(dir, e.name);
        if (e.name === 'node_modules') {
          out.push(abs);
          continue; // don't descend into node_modules
        }
        await walk(abs);
      }
    };
    await walk(root);
    return out;
  }

  describe.each(templates)('%s', (templateId) => {
    let projectDir: string;

    beforeAll(async () => {
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: templateId })
        .expect(201);
      projectDir = path.join(tmpRoot, res.body.id as string);
    }, 30_000);

    it('ships no dev-toolchain packages under any node_modules', async () => {
      const nmDirs = await findNodeModulesDirs(projectDir);
      for (const nm of nmDirs) {
        for (const dep of DEV_TOOLCHAIN) {
          // Check the actual package directory exists (handles scoped names
          // like @salesforce/vite-plugin-ui-bundle without false-positiving on
          // a sibling scoped prod dep such as @salesforce/sdk-data).
          const present = await fs
            .stat(path.join(nm, dep, 'package.json'))
            .then(() => true)
            .catch(() => false);
          expect(
            present,
            `${path.relative(projectDir, nm)} must not ship dev dependency "${dep}"`
          ).toBe(false);
        }
      }
    });

    it('has a node_modules only where a sibling package.json exists', async () => {
      const nmDirs = await findNodeModulesDirs(projectDir);
      for (const nm of nmDirs) {
        const siblingPkg = path.join(path.dirname(nm), 'package.json');
        await expect(
          fs.stat(siblingPkg),
          `unmanaged node_modules at ${path.relative(projectDir, nm)} — no sibling package.json`
        ).resolves.toBeDefined();
      }
    });

    it('does not ship a node_modules the template never declared', async () => {
      // The converse of the sibling-package.json test above: a template that ships no root
      // package.json (bundle layout, e.g. data-curator) must not carry a
      // root-level node_modules — that would be the stale, unmanaged tree the
      // build is responsible for excluding. Directly catches a host-specific
      // `zip -x` regression that the build's own post-zip check might miss.
      const hasRootPkg = await fs
        .stat(path.join(projectDir, 'package.json'))
        .then(() => true)
        .catch(() => false);
      if (!hasRootPkg) {
        await expect(
          fs.stat(path.join(projectDir, 'node_modules')),
          'bundle-layout project (no root package.json) must not ship a root node_modules'
        ).rejects.toThrow();
      }
    });

    it('ships react where the project declares it as a runtime dep', async () => {
      // Every built-in template's React app depends on react. Find the
      // package.json that declares it and assert react resolved into the
      // sibling node_modules.
      const nmDirs = await findNodeModulesDirs(projectDir);
      let foundReact = false;
      for (const nm of nmDirs) {
        const pkgPath = path.join(path.dirname(nm), 'package.json');
        let pkg: { dependencies?: Record<string, string> };
        try {
          pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as typeof pkg;
        } catch {
          continue;
        }
        if (pkg.dependencies?.react) {
          await expect(
            fs.stat(path.join(nm, 'react')),
            `react declared in ${path.relative(projectDir, pkgPath)} but not installed`
          ).resolves.toBeDefined();
          foundReact = true;
        }
      }
      expect(foundReact, 'expected at least one package.json declaring react').toBe(true);
    });
  });
});
