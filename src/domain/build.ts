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
import { BuildError } from '../errors.js';
import { logger } from '../logger.js';
import { shouldIgnoreEntry } from './files.js';

const BUILD_TIMEOUT_MS = 300_000; // 5 minutes
const REACT_EXTENSIONS = new Set(['.tsx', '.jsx']);

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
 * Run vite.build() programmatically with a 5-minute timeout.
 *
 * The service owns the build config — the user's project has no build tooling.
 * Build output goes to force-app/main/default/uiBundles/App/dist/ so SDR
 * picks it up as part of the UIBundle metadata deployment. (SDR renamed
 * WebApplication → UIBundle in 12.33.0; the platform renamed the metadata
 * type to match.)
 *
 * Coalesces concurrent builds for the same project directory.
 */
export async function runViteBuild(projectDir: string): Promise<void> {
  const existing = buildLocks.get(projectDir);
  if (existing) {
    logger.info({ projectDir }, 'Build already in progress, waiting');
    return existing;
  }

  const promise = doBuild(projectDir);
  buildLocks.set(projectDir, promise);
  try {
    await promise;
  } finally {
    buildLocks.delete(projectDir);
  }
}

async function doBuild(projectDir: string): Promise<void> {
  logger.info({ projectDir }, 'Running Vite build');

  const outDir = path.join(projectDir, 'force-app/main/default/uiBundles/App/dist');
  let timer: NodeJS.Timeout | undefined;
  try {
    const buildPromise = build({
      root: projectDir,
      base: './',
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
