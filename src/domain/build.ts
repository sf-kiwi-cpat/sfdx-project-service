import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { BuildError } from '../errors.js';
import { logger } from '../logger.js';

const BUILD_TIMEOUT_MS = 300_000; // 5 minutes
const REACT_EXTENSIONS = new Set(['.tsx', '.jsx']);

/**
 * Scan a project directory for .tsx or .jsx source files.
 */
export async function hasReactFiles(projectDir: string): Promise<boolean> {
  const entries = await fs.readdir(projectDir, { withFileTypes: true, recursive: true });
  return entries.some((e) => e.isFile() && REACT_EXTENSIONS.has(path.extname(e.name)));
}

/**
 * Run vite.build() programmatically with a 5-minute timeout.
 *
 * The service owns the build config — the user's project has no build tooling.
 * Build output goes to force-app/main/default/staticresources/App/ so SDR
 * picks it up as part of the normal metadata deployment.
 */
export async function runViteBuild(projectDir: string): Promise<void> {
  logger.info({ projectDir }, 'Running Vite build');

  let timer: NodeJS.Timeout | undefined;
  try {
    const buildPromise = build({
      root: projectDir,
      build: {
        outDir: path.join(projectDir, 'force-app/main/default/staticresources/App'),
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
