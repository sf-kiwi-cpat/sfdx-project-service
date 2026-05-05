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
const BUNDLE_DIR = 'force-app/main/default/uiBundles/App';

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

/**
 * Ensure a ui-bundle.json exists at the project root so
 * `@salesforce/vite-plugin-ui-bundle` can resolve it during `configResolved`
 * (the plugin reads `${vite.root}/ui-bundle.json`). For projects that already
 * have a manifest at the bundle dir, this writes a minimal project-root alias
 * pointing at the bundle's output dir. If the file is already present it's
 * a no-op.
 *
 * This is a transitional shim. The long-term shape is that templates live
 * entirely under `force-app/main/default/uiBundles/<name>/` and Vite's root
 * is the bundle dir — matching the webapps `base-react-app` convention.
 * Until templates are restructured, synthesizing at the project root keeps
 * the build working without changing the on-disk layout.
 */
async function ensureUiBundleManifest(projectDir: string, outDir: string): Promise<void> {
  const manifestPath = path.join(projectDir, 'ui-bundle.json');
  try {
    await fs.access(manifestPath);
    return;
  } catch {
    /* not present — synthesize */
  }
  const manifest = {
    outputDir: path.relative(projectDir, outDir),
    routing: { trailingSlash: 'never' as const, fallback: 'index.html' },
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  logger.info({ projectDir, manifestPath }, 'Synthesized ui-bundle.json for build');
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
  logger.info({ projectDir, orgAlias }, 'Running Vite build');

  // Resolve the real path so Vite/rolldown don't see symlink-prefixed
  // absolute paths (e.g. `/tmp/...` -> `/private/tmp/...` on macOS).
  // Without this, the vite:build-html plugin can reject `index.html`'s
  // absolute path during asset emission.
  const resolvedProjectDir = await fs.realpath(projectDir);
  const outDir = path.join(resolvedProjectDir, BUNDLE_DIR, 'dist');
  await ensureUiBundleManifest(resolvedProjectDir, outDir);

  let timer: NodeJS.Timeout | undefined;
  try {
    const buildPromise = build({
      root: resolvedProjectDir,
      base: './',
      configFile: false,
      plugins: [react(), uiBundlePlugin({ orgAlias, debug: false })],
      build: {
        outDir,
        emptyOutDir: true,
      },
      logLevel: 'silent',
    });

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
    if (timer) clearTimeout(timer);
  }

  logger.info({ projectDir }, 'Vite build completed');
}
