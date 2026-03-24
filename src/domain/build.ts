import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { BuildError } from '../errors.js';
import { logger } from '../logger.js';
import { shouldIgnoreEntry } from './files.js';

const BUILD_TIMEOUT_MS = 300_000; // 5 minutes
const REACT_EXTENSIONS = new Set(['.tsx', '.jsx']);

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
 * Build output goes to force-app/main/default/webapplications/App/dist/ so SDR
 * picks it up as part of the WebApplication metadata deployment.
 */
export async function runViteBuild(projectDir: string): Promise<void> {
  logger.info({ projectDir }, 'Running Vite build');

  let timer: NodeJS.Timeout | undefined;
  try {
    const buildPromise = build({
      root: projectDir,
      build: {
        outDir: path.join(projectDir, 'force-app/main/default/webapplications/App/dist'),
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
      throw new BuildError('Build timeout after 5 minutes');
    }
    const msg = err instanceof Error ? err.message : 'Build failed';
    throw new BuildError(msg);
  } finally {
    if (timer) clearTimeout(timer);
  }

  logger.info({ projectDir }, 'Vite build completed');
}
