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

import path from 'node:path';

/**
 * Project root - where the SFDX project lives. Defaults to cwd; can be overridden via env for EFS mount.
 * Read at call time to support test isolation.
 */
export function getProjectPath(): string {
  return process.env.PROJECT_ROOT ?? process.cwd();
}

/**
 * Root directory for created projects. Each project gets a UUID subdirectory.
 */
export function getProjectsRoot(): string {
  return process.env.PROJECTS_ROOT ?? path.resolve(process.cwd(), 'projects');
}

/**
 * Directory containing template ZIP files. Resolved relative to the package root
 * (one level up from dist/ at runtime).
 */
export function getTemplatesDir(): string {
  return process.env.TEMPLATES_DIR ?? path.resolve(import.meta.dirname, '..', 'templates', 'dist');
}

/**
 * Default production debounce window (ms) for the filesystem watcher.
 * Rapid successive writes to the same path within this window collapse into
 * a single event carrying the latest content.
 */
const DEFAULT_WATCHER_DEBOUNCE_MS = 300;

/**
 * Default production stability threshold (ms) — chokidar
 * `awaitWriteFinish.stabilityThreshold`. Writes are only surfaced after the
 * file has been quiet for this long.
 */
const DEFAULT_WATCHER_STABILITY_MS = 200;

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

/**
 * Per-path debounce window (ms) for the filesystem event watcher.
 * Override with WATCHER_DEBOUNCE_MS. Used by `src/domain/watcher.ts`.
 */
export function getWatcherDebounceMs(): number {
  return parsePositiveIntEnv(process.env.WATCHER_DEBOUNCE_MS, DEFAULT_WATCHER_DEBOUNCE_MS);
}

/**
 * Stability threshold (ms) for chokidar's `awaitWriteFinish`. A file must
 * remain unchanged for this long before chokidar surfaces the event.
 * Override with WATCHER_STABILITY_MS.
 */
export function getWatcherStabilityMs(): number {
  return parsePositiveIntEnv(process.env.WATCHER_STABILITY_MS, DEFAULT_WATCHER_STABILITY_MS);
}
