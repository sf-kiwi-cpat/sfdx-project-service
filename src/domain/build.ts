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
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import uiBundlePlugin from '@salesforce/vite-plugin-ui-bundle';
import { BuildError } from '../errors.js';
import { logger } from '../logger.js';
import { shouldIgnoreEntry } from './files.js';

const BUILD_TIMEOUT_MS = 300_000; // 5 minutes
const REACT_EXTENSIONS = new Set(['.tsx', '.jsx']);
const UI_BUNDLES_REL = 'force-app/main/default/uiBundles';
const STATIC_RESOURCES_REL = 'force-app/main/default/staticresources';

/**
 * Resolve the project's bundle directory (relative to the project root).
 * The bundle name is per-project unique — see spec/app-naming. Falls
 * back to the literal `uiBundles/App` if no bundle directory exists yet
 * so callers that consume `BUNDLE_DIR`-style paths still get something
 * pointable. Callers that need to deploy MUST go through `runViteBuild`,
 * which resolves the layout for real.
 */
async function resolveBundleRel(projectDir: string): Promise<string> {
  const uiBundlesRoot = path.join(projectDir, UI_BUNDLES_REL);
  try {
    const entries = await fs.readdir(uiBundlesRoot);
    if (entries.length === 1) {
      return path.join(UI_BUNDLES_REL, entries[0]);
    }
  } catch {
    /* no bundles dir; return legacy fallback */
  }
  return `${UI_BUNDLES_REL}/App`;
}

/**
 * Detect the first StaticResource directory under staticresources/ that
 * has a corresponding .resource-meta.xml with contentType application/zip.
 * Returns the directory name, or null if none found.
 */
async function resolveStaticResourceName(projectDir: string): Promise<string | null> {
  const srRoot = path.join(projectDir, STATIC_RESOURCES_REL);
  try {
    const entries = await fs.readdir(srRoot);
    for (const entry of entries) {
      if (entry.endsWith('.resource-meta.xml')) {
        const metaPath = path.join(srRoot, entry);
        const content = await fs.readFile(metaPath, 'utf8');
        if (content.includes('application/zip')) {
          return entry.replace('.resource-meta.xml', '');
        }
      }
    }
  } catch {
    /* no staticresources dir */
  }
  return null;
}

const buildLocks = new Map<string, Promise<void>>();

/**
 * Scan a project directory for .tsx or .jsx source files.
 * Skips node_modules, .git, and other ignored directories to avoid
 * false positives from dependency files and to bound memory usage.
 */
export async function hasReactFiles(projectDir: string): Promise<boolean> {
  async function walk(dir: string): Promise<boolean> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldIgnoreEntry(entry.name)) continue;
      if (entry.isFile() && REACT_EXTENSIONS.has(path.extname(entry.name))) {
        return true;
      }
      if (entry.isDirectory()) {
        if (await walk(path.join(dir, entry.name))) return true;
      }
    }
    return false;
  }
  return walk(projectDir);
}

interface ResolvedLayout {
  viteRoot: string;
  outDir: string;
  layout: 'bundle' | 'legacy' | 'staticresource';
  /** StaticResource name (e.g. "EnhancedChatApp") — only set for staticresource layout */
  staticResourceName?: string;
}

/**
 * Determine Vite's root directory for a project.
 *
 * Three supported layouts:
 *
 * - **StaticResource layout**: a `staticresources/<Name>.resource-meta.xml` with
 *   `contentType: application/zip` exists. Vite builds an IIFE bundle into
 *   `staticresources/<Name>/` so SDR auto-zips it for deploy. Used for React apps
 *   hosted by VF pages (which have permissive CSP, unlike UIBundle's `script-src self`).
 *
 * - **Bundle layout** (preferred UIBundle): `uiBundles/App/` contains `index.html`.
 *   Vite roots at the bundle dir, builds into `<bundle>/dist`.
 *
 * - **Legacy layout** (transitional UIBundle): `index.html` + `src/` at project root.
 *   Vite roots at project dir, outputs to `<bundle>/dist`.
 */
async function resolveLayout(projectDir: string): Promise<ResolvedLayout> {
  // StaticResource layout takes priority — check for zip-typed resource first.
  const srName = await resolveStaticResourceName(projectDir);
  if (srName) {
    return {
      viteRoot: projectDir,
      outDir: path.join(projectDir, STATIC_RESOURCES_REL, srName),
      layout: 'staticresource',
      staticResourceName: srName,
    };
  }

  const bundleRel = await resolveBundleRel(projectDir);
  const bundleDir = path.join(projectDir, bundleRel);
  const bundleIndexHtml = path.join(bundleDir, 'index.html');
  try {
    await fs.access(bundleIndexHtml);
    return {
      viteRoot: bundleDir,
      outDir: path.join(bundleDir, 'dist'),
      layout: 'bundle',
    };
  } catch {
    /* fall through to legacy layout */
  }
  return {
    viteRoot: projectDir,
    outDir: path.join(projectDir, bundleRel, 'dist'),
    layout: 'legacy',
  };
}

/**
 * Ensure a `ui-bundle.json` exists at Vite's root so
 * `@salesforce/vite-plugin-ui-bundle` can resolve it during `configResolved`
 * (the plugin reads `${config.root}/ui-bundle.json`). If the template
 * already ships one — which is the case under bundle layout — leave it
 * alone. Under legacy layout, synthesize a minimal one at the project
 * root pointing at the bundle's output dir.
 */
async function ensureUiBundleManifest(viteRoot: string, outDir: string): Promise<void> {
  const manifestPath = path.join(viteRoot, 'ui-bundle.json');
  try {
    await fs.access(manifestPath);
    return;
  } catch {
    /* not present — synthesize */
  }
  const manifest = {
    outputDir: path.relative(viteRoot, outDir),
    routing: { trailingSlash: 'never' as const, fallback: 'index.html' },
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  logger.info({ viteRoot, manifestPath }, 'Synthesized ui-bundle.json for build');
}

/**
 * Run vite.build() programmatically with a 5-minute timeout.
 *
 * The service owns the build plugins — `@vitejs/plugin-react` compiles JSX
 * and `@salesforce/vite-plugin-ui-bundle` applies Salesforce-specific
 * transforms (API-version injection, base-href, manifest routing). Templates
 * ship React sources only; no per-template `vite.config.*` is honored
 * (`configFile: false`), preserving the deploy contract.
 *
 * Build output goes to force-app/main/default/uiBundles/App/dist/ so SDR
 * picks it up as part of the UIBundle metadata deployment.
 *
 * `orgAlias` is forwarded to the plugin so `getOrgInfo` can resolve the
 * target org's API version and inject `__SF_API_VERSION__` at build time.
 *
 * Coalesces concurrent builds for the same project directory.
 */
export async function runViteBuild(projectDir: string, orgAlias?: string): Promise<void> {
  const existing = buildLocks.get(projectDir);
  if (existing) {
    logger.info({ projectDir }, 'Build already in progress, waiting');
    return existing;
  }

  const promise = doBuild(projectDir, orgAlias);
  buildLocks.set(projectDir, promise);
  try {
    await promise;
  } finally {
    buildLocks.delete(projectDir);
  }
}

async function doBuild(projectDir: string, orgAlias?: string): Promise<void> {
  // Resolve the real path so Vite/rolldown don't see symlink-prefixed
  // absolute paths (e.g. `/tmp/...` -> `/private/tmp/...` on macOS).
  // Without this, the vite:build-html plugin can reject `index.html`'s
  // absolute path during asset emission.
  const resolvedProjectDir = await fs.realpath(projectDir);
  const { viteRoot, outDir, layout, staticResourceName } = await resolveLayout(resolvedProjectDir);
  logger.info({ projectDir, orgAlias, viteRoot, layout }, 'Running Vite build');

  let timer: NodeJS.Timeout | undefined;
  try {
    let buildPromise: Promise<unknown>;
    if (layout === 'staticresource' && staticResourceName) {
      // IIFE build for StaticResource layout — no UIBundle plugin.
      // VF pages host the React app and have permissive CSP, unlike UIBundle.
      // After build, rename Vite's default CSS output (derived from package
      // name) to match the StaticResource name so {!URLFOR($Resource.X, 'X.css')} resolves.
      const srName = staticResourceName;
      buildPromise = build({
        root: viteRoot,
        configFile: false,
        plugins: [
          react(),
          {
            name: 'rename-css-and-write-index',
            closeBundle: async () => {
              const files = await fs.readdir(outDir);
              for (const f of files) {
                if (f.endsWith('.css') && f !== `${srName}.css`) {
                  await fs.rename(path.join(outDir, f), path.join(outDir, `${srName}.css`));
                }
              }
              // Write index.html so the VF page can load the bundle.
              // emptyOutDir wipes the dir before Vite writes JS/CSS; closeBundle
              // runs after, so this is the correct place to write it.
              const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${srName}</title>
    <link rel="stylesheet" href="/resource/${srName}/${srName}.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="/resource/${srName}/${srName}.js"></script>
  </body>
</html>`;
              await fs.writeFile(path.join(outDir, 'index.html'), indexHtml);
            },
          },
        ],
        build: {
          lib: {
            entry: path.join(viteRoot, 'src/main.jsx'),
            name: srName,
            formats: ['iife'],
            fileName: () => `${srName}.js`,
          },
          outDir,
          emptyOutDir: true,
          cssCodeSplit: false,
        },
        logLevel: 'silent',
      });
    } else {
      await ensureUiBundleManifest(viteRoot, outDir);
      buildPromise = build({
        root: viteRoot,
        base: './',
        configFile: false,
        plugins: [react(), uiBundlePlugin({ orgAlias, debug: false })],
        build: {
          outDir,
          emptyOutDir: true,
        },
        logLevel: 'silent',
      });
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      }, BUILD_TIMEOUT_MS);
    });

    await Promise.race([buildPromise, timeoutPromise]);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn({ projectDir }, 'Build timed out — orphaned vite.build() may still be running');
      fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
      throw new BuildError('Build timeout after 5 minutes');
    }
    const msg = err instanceof Error ? err.message : 'Build failed';
    throw new BuildError(msg);
  } finally {
    /* v8 ignore next */ // justification: timer is always assigned before any await in the try block, so the falsy branch is unreachable; the guard is kept for future refactors that might short-circuit before the assignment
    if (timer) clearTimeout(timer);
  }

  // Under bundle layout the template ships React sources inside the UIBundle
  // directory (src/, index.html, package.json, node_modules/). SDR walks the
  // entire bundle dir and would upload all of those to the platform. Write a
  // .forceignore so SDR only deploys the built dist/ output.
  if (layout === 'bundle') {
    const bundleRelDir = path.relative(resolvedProjectDir, viteRoot);
    const forceignorePath = path.join(resolvedProjectDir, '.forceignore');
    const lines = [
      `${bundleRelDir}/src`,
      `${bundleRelDir}/node_modules`,
      `${bundleRelDir}/package.json`,
      `${bundleRelDir}/package-lock.json`,
      `${bundleRelDir}/index.html`,
      `${bundleRelDir}/uibundle.json`,
    ];
    await fs.writeFile(forceignorePath, lines.join('\n') + '\n');
    logger.info(
      { forceignorePath, bundleRelDir },
      'Wrote .forceignore to exclude bundle sources from deploy'
    );
  }

  logger.info({ projectDir }, 'Vite build completed');
}
