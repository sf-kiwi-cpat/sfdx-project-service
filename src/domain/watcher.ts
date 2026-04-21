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
 * Filesystem watcher subsystem for the `/v1/projects/:id/fs/events` SSE
 * endpoint. Each project has at most one underlying chokidar watcher; SSE
 * subscribers attach to the per-project watcher via reference counting.
 *
 * - First subscriber for a project starts the watcher.
 * - Last subscriber to disconnect tears the watcher down.
 * - Writes are debounced per-path (last-write-wins within the window).
 * - Content inclusion uses a binary deny-list + <100KB size cutoff.
 *
 * See spec/fs-events/contract.md for the external contract.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { getWatcherDebounceMs } from '../config.js';
import { shouldIgnoreEntry } from './files.js';
import { logger } from '../logger.js';

/** Event types surfaced to subscribers. Maps to SSE event names below. */
export type FileEventType = 'add' | 'change' | 'unlink';

export interface FileEvent {
  /** POSIX-style project-relative path (e.g., `src/components/App.js`). */
  path: string;
  /** `'add' | 'change' | 'unlink'` — applies to files only. */
  type: FileEventType;
  /** Present on `add`/`change` when text + under the size cutoff. */
  content?: string;
}

/** Strict less-than cutoff: files of this size or larger omit content. */
const CONTENT_SIZE_CUTOFF_BYTES = 100 * 1024;

/** Deny-list of binary extensions — matches contract.md §Content inclusion rules. */
const BINARY_EXTENSIONS = new Set<string>([
  '.png',
  '.jpg',
  '.gif',
  '.webp',
  '.pdf',
  '.zip',
  '.woff',
  '.woff2',
  '.ttf',
]);

/**
 * Additional per-project ignores layered on top of `shouldIgnoreEntry()`.
 * Public `.project-meta.json` writes must not leak into the event stream.
 */
const EXTRA_IGNORED_NAMES = new Set(['.project-meta.json']);

export type FileEventListener = (evt: FileEvent) => void;

interface PerProjectWatcher {
  projectDir: string;
  watcher: FSWatcher;
  listeners: Set<FileEventListener>;
  /** Per-path pending debounce timers + the latest observed event type. */
  pending: Map<string, { type: FileEventType; timer: NodeJS.Timeout }>;
  /** Resolves once chokidar has completed its initial scan. */
  ready: Promise<void>;
  /**
   * Snapshot of `(size, mtimeMs)` captured at ready for every file seen
   * during the initial scan. Used to suppress late-arriving FSEvents
   * `change` notifications that replay pre-existing bytes — if the file's
   * current stat matches the snapshot, the OS is telling us about a write
   * that already happened before we attached and there is no real change
   * to surface (contract: `ignoreInitial: true`). Once a file genuinely
   * changes (or gets unlinked), the snapshot entry is removed, and all
   * subsequent events for that path surface normally.
   */
  initialSnap: Map<string, { size: number; mtimeMs: number }>;
}

/** Decide whether the binary deny-list excludes content for this path. */
function isBinaryExtension(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/** Convert any platform-native path separator into POSIX-style for payloads. */
function toPosix(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

/**
 * Decide whether a given relative path should be ignored (not emitted).
 * Mirrors `shouldIgnoreEntry()` (dotfiles at any depth, node_modules, .git,
 * .sf) and adds `.project-meta.json`.
 */
function shouldIgnorePath(relPath: string): boolean {
  const segments = relPath.split(/[/\\]/).filter(Boolean);
  if (segments.some((seg) => shouldIgnoreEntry(seg))) return true;
  if (segments.some((seg) => EXTRA_IGNORED_NAMES.has(seg))) return true;
  return false;
}

/**
 * Read file content if eligible (not binary, under cutoff, readable). Returns
 * `undefined` if content should be omitted for any reason — including races
 * with a subsequent unlink, per contract.md §Content inclusion rules.
 */
async function readContentIfEligible(
  absPath: string,
  relPath: string
): Promise<string | undefined> {
  if (isBinaryExtension(relPath)) return undefined;
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  if (stat.size >= CONTENT_SIZE_CUTOFF_BYTES) return undefined;
  try {
    return await fs.readFile(absPath, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Refcounted per-project watcher registry. Singleton accessed via the module
 * exports at the bottom of this file.
 */
export class WatcherManager {
  private readonly watchers = new Map<string, PerProjectWatcher>();

  /**
   * Subscribe to filesystem events for `projectId`. Starts the underlying
   * chokidar watcher on first subscription; shares it across concurrent
   * subscribers. Returns a `Promise<() => void>` — the promise resolves once
   * chokidar has completed its initial scan (so any write a client performs
   * after awaiting is guaranteed to be observable), and the resolved value
   * is the `unsubscribe` function. When the last subscriber unsubscribes,
   * the watcher is torn down.
   */
  async subscribe(
    projectId: string,
    projectDir: string,
    listener: FileEventListener
  ): Promise<() => void> {
    let entry = this.watchers.get(projectId);
    if (!entry) {
      entry = this.createWatcher(projectId, projectDir);
      this.watchers.set(projectId, entry);
    }
    entry.listeners.add(listener);

    // Wait for the initial scan to complete before returning — otherwise
    // writes that land during the scan window may be misclassified (an
    // edit to a pre-existing file can surface as `add` instead of `change`).
    await entry.ready;

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const current = this.watchers.get(projectId);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        void this.teardown(projectId);
      }
    };
  }

  /** Graceful shutdown — close every underlying watcher. */
  async closeAll(): Promise<void> {
    const projectIds = [...this.watchers.keys()];
    await Promise.all(projectIds.map((id) => this.teardown(id)));
  }

  /* ----------------------------- internals ----------------------------- */

  private createWatcher(projectId: string, projectDir: string): PerProjectWatcher {
    // We implement our own per-path debouncing (see `enqueue`) and source
    // the file's final content via a direct `readFile` at flush time, so
    // chokidar's `awaitWriteFinish` (size-polling stability gate) is
    // redundant and in practice drops events for very small writes —
    // keep it off.
    //
    // Use polling rather than native FSEvents/inotify. On macOS, FSEvents
    // is unreliable right after subscribing (a small window where writes
    // are silently dropped), which surfaces as intermittent failures under
    // rapid watcher create/destroy cycles. Polling has deterministic delivery
    // guarantees at the cost of a small amount of CPU — acceptable for a
    // service that watches one project directory at a time. `usePolling`
    // can be disabled via `WATCHER_USE_POLLING=0` for deployments where
    // native watchers are known-good.
    const usePolling = process.env.WATCHER_USE_POLLING !== '0';
    const watcher = chokidar.watch(projectDir, {
      persistent: true,
      ignoreInitial: true,
      usePolling,
      interval: usePolling ? 50 : undefined,
      binaryInterval: usePolling ? 50 : undefined,
      ignored: (absPath: string) => {
        if (absPath === projectDir) return false;
        const rel = path.relative(projectDir, absPath);
        if (!rel || rel.startsWith('..')) return false;
        return shouldIgnorePath(rel);
      },
    });

    const initialSnap = new Map<string, { size: number; mtimeMs: number }>();
    const readyHandled = { done: false };

    const ready = new Promise<void>((resolve) => {
      watcher.once('ready', () => {
        // Snapshot every file chokidar knows about so we can later
        // distinguish real post-ready changes from stale FSEvents replay.
        // `getWatched()` returns directories → immediate child names.
        const tracked = watcher.getWatched();
        const snapshots: Array<Promise<void>> = [];
        for (const [dir, names] of Object.entries(tracked)) {
          for (const name of names) {
            const abs = path.join(dir, name);
            const rel = path.relative(projectDir, abs);
            if (!rel || rel.startsWith('..')) continue;
            if (shouldIgnorePath(rel)) continue;
            snapshots.push(
              fs.stat(abs).then(
                (st) => {
                  if (st.isFile()) {
                    initialSnap.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
                  }
                },
                () => {
                  /* file disappeared between scan & stat — ignore */
                }
              )
            );
          }
        }
        Promise.all(snapshots).then(() => {
          readyHandled.done = true;
          resolve();
        });
      });
    });

    const entry: PerProjectWatcher = {
      projectDir,
      watcher,
      listeners: new Set(),
      pending: new Map(),
      ready,
      initialSnap,
    };

    watcher.on('add', (absPath) => {
      // Pre-ready `add` never fires (ignoreInitial: true). Post-ready
      // `add` is always legitimate — forward it.
      if (!readyHandled.done) return;
      this.enqueue(entry, absPath, 'add');
    });
    watcher.on('change', (absPath) => this.enqueue(entry, absPath, 'change'));
    watcher.on('unlink', (absPath) => this.enqueue(entry, absPath, 'unlink'));
    watcher.on('error', (err) => {
      logger.warn({ err, projectId }, 'fs-events watcher error');
    });

    return entry;
  }

  private async enqueue(
    entry: PerProjectWatcher,
    absPath: string,
    type: FileEventType
  ): Promise<void> {
    const rel = path.relative(entry.projectDir, absPath);
    if (!rel || rel.startsWith('..')) return;
    if (shouldIgnorePath(rel)) return;

    // Guard against late-arriving FSEvents for the initial scan's files.
    // On macOS especially, chokidar fires `ready` before the kernel has
    // finished delivering notifications for bytes that were already on
    // disk before the watcher attached; those deliveries arrive as
    // `change` events despite the file never changing post-ready.
    // Compare the current stat to the snapshot we captured at ready:
    // same (size, mtimeMs) means stale FSEvents replay — suppress it.
    if (type === 'change') {
      const snap = entry.initialSnap.get(rel);
      if (snap) {
        try {
          const st = await fs.stat(absPath);
          if (st.size === snap.size && st.mtimeMs === snap.mtimeMs) return;
        } catch {
          /* file missing — fall through; unlink will follow */
        }
        entry.initialSnap.delete(rel);
      }
    } else {
      entry.initialSnap.delete(rel);
    }

    const debounceMs = getWatcherDebounceMs();

    const existing = entry.pending.get(rel);
    // Resolve the coalesced type for this path within the window:
    // - `add` then `change` collapses to `add` (a brand-new file's first
    //   surfaced event is its creation, carrying the latest content).
    // - Any other combination takes the newer type (including `unlink`
    //   superseding earlier events on the same path).
    let resolvedType: FileEventType = type;
    if (existing) {
      clearTimeout(existing.timer);
      if (existing.type === 'add' && type === 'change') {
        resolvedType = 'add';
      }
    }

    const timer = setTimeout(() => {
      void this.flush(entry, rel);
    }, debounceMs);

    entry.pending.set(rel, { type: resolvedType, timer });
  }

  private async flush(entry: PerProjectWatcher, relPath: string): Promise<void> {
    const pending = entry.pending.get(relPath);
    if (!pending) return;
    entry.pending.delete(relPath);

    const posixPath = toPosix(relPath);
    let evt: FileEvent;
    if (pending.type === 'unlink') {
      evt = { path: posixPath, type: 'unlink' };
    } else {
      const absPath = path.join(entry.projectDir, relPath);
      const content = await readContentIfEligible(absPath, relPath);
      evt =
        content === undefined
          ? { path: posixPath, type: pending.type }
          : { path: posixPath, type: pending.type, content };
    }

    // Snapshot listeners to avoid mutation-during-iteration surprises.
    const listeners = [...entry.listeners];
    for (const listener of listeners) {
      try {
        listener(evt);
      } catch (err) {
        /* v8 ignore next 2 -- defensive: listener exceptions must not break peers */
        logger.warn({ err }, 'fs-events listener threw');
      }
    }
  }

  private async teardown(projectId: string): Promise<void> {
    const entry = this.watchers.get(projectId);
    if (!entry) return;
    this.watchers.delete(projectId);
    for (const { timer } of entry.pending.values()) {
      clearTimeout(timer);
    }
    entry.pending.clear();
    entry.listeners.clear();
    try {
      await entry.watcher.close();
    } catch (err) {
      /* v8 ignore next 2 -- chokidar close rarely rejects; don't mask shutdown */
      logger.warn({ err, projectId }, 'fs-events watcher close failed');
    }
  }
}

/** Process-wide singleton used by the route layer. */
export const watcherManager = new WatcherManager();
