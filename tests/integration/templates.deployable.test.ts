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

    it('creates a project via POST /v1/projects', async () => {
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: templateId })
        .expect(201);
      projectId = res.body.id as string;
      projectDir = path.join(tmpRoot, projectId);
      expect(projectId).toBeDefined();
    });

    it('sfdx-project.json pins API version >= 66.0', async () => {
      const raw = await fs.readFile(path.join(projectDir, 'sfdx-project.json'), 'utf-8');
      const cfg = JSON.parse(raw) as { sourceApiVersion?: string };
      expect(cfg.sourceApiVersion, 'sourceApiVersion must be declared').toBeDefined();
      const v = parseFloat(cfg.sourceApiVersion as string);
      expect(v, 'UIBundle requires API 66.0+').toBeGreaterThanOrEqual(66.0);
    });

    it('ships App.uibundle-meta.xml with canonical lowercase suffix', async () => {
      const dir = path.join(projectDir, 'force-app/main/default/uiBundles/App');
      const entries = await fs.readdir(dir);
      expect(entries).toContain('App.uibundle-meta.xml');
      // Belt-and-suspenders: make sure the mixed-case form is gone —
      // it'd silently succeed on macOS and fail on Linux / SDR's server.
      expect(entries).not.toContain('App.uiBundle-meta.xml');
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

      const distDir = path.join(projectDir, 'force-app/main/default/uiBundles/App/dist');
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
