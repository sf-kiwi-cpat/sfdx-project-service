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
 * Unit coverage for the WatcherManager edge cases not exercised by the
 * fs-events contract spec: idempotent unsubscribe, closeAll with no active
 * watchers, listener exceptions not breaking peers, and symbol exports.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PreReadyEventBuffer, WatcherManager, watcherManager } from '../../src/domain/watcher.js';
import type { FileEvent } from '../../src/domain/watcher.js';

describe('PreReadyEventBuffer', () => {
  it('buffers events until released', () => {
    const buf = new PreReadyEventBuffer();
    expect(buf.accept('/p/a.txt', 'add')).toBe('buffer');
    expect(buf.accept('/p/b.txt', 'change')).toBe('buffer');
  });

  it('forwards events once released', () => {
    const buf = new PreReadyEventBuffer();
    buf.release();
    expect(buf.accept('/p/a.txt', 'add')).toBe('forward');
  });

  it('release returns every buffered event in insertion order', () => {
    const buf = new PreReadyEventBuffer();
    buf.accept('/p/a.txt', 'add');
    buf.accept('/p/b.txt', 'change');
    buf.accept('/p/a.txt', 'unlink');
    expect(buf.release()).toEqual([
      { absPath: '/p/a.txt', type: 'add' },
      { absPath: '/p/b.txt', type: 'change' },
      { absPath: '/p/a.txt', type: 'unlink' },
    ]);
  });

  it('release is idempotent — subsequent calls return an empty array', () => {
    const buf = new PreReadyEventBuffer();
    buf.accept('/p/a.txt', 'add');
    expect(buf.release()).toHaveLength(1);
    expect(buf.release()).toEqual([]);
    expect(buf.release()).toEqual([]);
  });

  it('events offered after release are not buffered', () => {
    const buf = new PreReadyEventBuffer();
    buf.accept('/p/a.txt', 'add');
    const replayed = buf.release();
    expect(replayed).toEqual([{ absPath: '/p/a.txt', type: 'add' }]);
    // This is the post-window case: the event must flow normally, not be
    // retained for a second replay.
    expect(buf.accept('/p/b.txt', 'add')).toBe('forward');
    expect(buf.release()).toEqual([]);
  });
});

describe('WatcherManager', () => {
  let tmpDir: string;
  let projectDir: string;
  let manager: WatcherManager;
  let originalDebounce: string | undefined;

  beforeAll(() => {
    originalDebounce = process.env.WATCHER_DEBOUNCE_MS;
    // Keep the debounce short so tests finish quickly.
    process.env.WATCHER_DEBOUNCE_MS = '50';
  });

  afterAll(() => {
    if (originalDebounce === undefined) {
      delete process.env.WATCHER_DEBOUNCE_MS;
    } else {
      process.env.WATCHER_DEBOUNCE_MS = originalDebounce;
    }
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watcher-unit-'));
    projectDir = path.join(tmpDir, 'project');
    await fs.mkdir(projectDir);
    manager = new WatcherManager();
  });

  afterEach(async () => {
    await manager.closeAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('exports a process-wide singleton', () => {
    expect(watcherManager).toBeInstanceOf(WatcherManager);
  });

  it('unsubscribe is idempotent — calling twice is a no-op', async () => {
    const unsubscribe = await manager.subscribe('pid', projectDir, () => {});
    unsubscribe();
    // Second call must not throw and must not log a warning.
    expect(() => unsubscribe()).not.toThrow();
  });

  it('unsubscribe after closeAll does not throw', async () => {
    const unsubscribe = await manager.subscribe('pid', projectDir, () => {});
    await manager.closeAll();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('closeAll is a no-op when no watchers are active', async () => {
    await expect(manager.closeAll()).resolves.toBeUndefined();
  });

  it('a listener that throws does not prevent peers from receiving the event', async () => {
    const received: FileEvent[] = [];
    const bad = (): void => {
      throw new Error('boom');
    };
    const good = (evt: FileEvent): void => {
      received.push(evt);
    };

    await manager.subscribe('pid', projectDir, bad);
    await manager.subscribe('pid', projectDir, good);

    await fs.writeFile(path.join(projectDir, 'file.txt'), 'hello');

    // Wait past the debounce window.
    await new Promise((r) => setTimeout(r, 400));
    expect(received.some((e) => e.path === 'file.txt' && e.type === 'add')).toBe(true);
  });

  it('two subscribers on the same project share one underlying watcher', async () => {
    const eventsA: FileEvent[] = [];
    const eventsB: FileEvent[] = [];

    await manager.subscribe('pid', projectDir, (e) => eventsA.push(e));
    await manager.subscribe('pid', projectDir, (e) => eventsB.push(e));

    await fs.writeFile(path.join(projectDir, 'shared.txt'), 'payload');
    await new Promise((r) => setTimeout(r, 400));

    expect(eventsA.some((e) => e.path === 'shared.txt')).toBe(true);
    expect(eventsB.some((e) => e.path === 'shared.txt')).toBe(true);
  });

  it('tears down the watcher once the last subscriber disconnects', async () => {
    const events: FileEvent[] = [];
    const unsubscribe = await manager.subscribe('pid', projectDir, (e) => events.push(e));

    // Sanity check: an event flows before teardown.
    await fs.writeFile(path.join(projectDir, 'before.txt'), 'a');
    await new Promise((r) => setTimeout(r, 200));
    expect(events.some((e) => e.path === 'before.txt')).toBe(true);

    // Teardown.
    unsubscribe();
    // Writes made after teardown should not surface (no listeners).
    const beforeCount = events.length;
    await fs.writeFile(path.join(projectDir, 'after.txt'), 'b');
    await new Promise((r) => setTimeout(r, 200));
    expect(events.length).toBe(beforeCount);
  });

  it('closeAll tears down watchers with pending debounce timers', async () => {
    // Subscribe, then trigger a write so a debounce timer is armed. Calling
    // closeAll before the timer fires must cleanly clear the timers (exercises
    // the timer-clearing branch in teardown).
    const unsubscribe = await manager.subscribe('pid', projectDir, () => {});
    await fs.writeFile(path.join(projectDir, 'pending.txt'), 'x');
    // Don't wait for the debounce to flush — tear down mid-flight.
    await manager.closeAll();
    // If timers weren't cleared, node would keep the event loop alive.
    expect(() => unsubscribe()).not.toThrow();
  });

  it('surfaces a single `add` event when an add is followed by a rapid change', async () => {
    // Exercises the add+change → add coalescing branch in enqueue().
    // Bump the debounce so chokidar has time to emit a distinct `change`
    // event between the two writes (otherwise the `writeFile` pair can
    // land within a single OS poll tick and look like a single `add`).
    process.env.WATCHER_DEBOUNCE_MS = '300';
    try {
      const events: FileEvent[] = [];
      await manager.subscribe('pid', projectDir, (e) => events.push(e));

      const target = path.join(projectDir, 'new-file.txt');
      await fs.writeFile(target, 'first');
      // Small gap so chokidar sees the add before the next poll tick,
      // then a second write that should surface as `change`.
      await new Promise((r) => setTimeout(r, 120));
      await fs.writeFile(target, 'second');

      await new Promise((r) => setTimeout(r, 600));
      const matches = events.filter((e) => e.path === 'new-file.txt');
      expect(matches).toHaveLength(1);
      expect(matches[0].type).toBe('add');
      expect(matches[0].content).toBe('second');
    } finally {
      process.env.WATCHER_DEBOUNCE_MS = '50';
    }
  });

  it('ignores writes inside gitignored-style paths (node_modules, dotfiles)', async () => {
    // Exercises the shouldIgnorePath branch in enqueue().
    const events: FileEvent[] = [];
    await manager.subscribe('pid', projectDir, (e) => events.push(e));

    await fs.mkdir(path.join(projectDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'node_modules', 'pkg.json'), '{}');
    await fs.writeFile(path.join(projectDir, '.hidden'), 'secret');

    await new Promise((r) => setTimeout(r, 300));
    expect(events.filter((e) => e.path.startsWith('node_modules'))).toHaveLength(0);
    expect(events.filter((e) => e.path.startsWith('.hidden'))).toHaveLength(0);
  });

  it('omits content for binary extensions (e.g. .png)', async () => {
    // Exercises the binary-deny-list branch in readContentIfEligible.
    const events: FileEvent[] = [];
    await manager.subscribe('pid', projectDir, (e) => events.push(e));

    await fs.writeFile(path.join(projectDir, 'pixel.png'), 'not-really-png');
    await new Promise((r) => setTimeout(r, 300));

    const match = events.find((e) => e.path === 'pixel.png');
    expect(match).toBeDefined();
    expect(match?.content).toBeUndefined();
  });

  it('omits content for files >= 100KB', async () => {
    // Exercises the size-cutoff branch in readContentIfEligible.
    const events: FileEvent[] = [];
    await manager.subscribe('pid', projectDir, (e) => events.push(e));

    // 100 * 1024 bytes is the strict-less-than cutoff — write exactly that.
    const big = 'a'.repeat(100 * 1024);
    await fs.writeFile(path.join(projectDir, 'big.txt'), big);
    await new Promise((r) => setTimeout(r, 300));

    const match = events.find((e) => e.path === 'big.txt');
    expect(match).toBeDefined();
    expect(match?.content).toBeUndefined();
  });

  it('emits `unlink` when a file is removed', async () => {
    // Exercises the unlink branch in flush() (no content lookup).
    const events: FileEvent[] = [];
    await manager.subscribe('pid', projectDir, (e) => events.push(e));

    const target = path.join(projectDir, 'doomed.txt');
    await fs.writeFile(target, 'bye');
    await new Promise((r) => setTimeout(r, 150));
    await fs.rm(target);
    await new Promise((r) => setTimeout(r, 300));

    expect(events.some((e) => e.path === 'doomed.txt' && e.type === 'unlink')).toBe(true);
  });

  it('ignores writes to .project-meta.json', async () => {
    // Exercises the EXTRA_IGNORED_NAMES branch in shouldIgnorePath.
    const events: FileEvent[] = [];
    await manager.subscribe('pid', projectDir, (e) => events.push(e));

    await fs.writeFile(path.join(projectDir, '.project-meta.json'), '{}');
    await new Promise((r) => setTimeout(r, 300));

    expect(events.filter((e) => e.path === '.project-meta.json')).toHaveLength(0);
  });

  it('decodes file content as UTF-8 — non-UTF-8 bytes become U+FFFD', async () => {
    // Pins the UTF-8 assumption at the watcher layer. The contract-level
    // test covers the full SSE round-trip; this is a fast isolated check
    // that readContentIfEligible hands back a UTF-8-decoded string with
    // replacement characters for invalid byte sequences rather than raw
    // bytes or a thrown error.
    const events: FileEvent[] = [];
    await manager.subscribe('pid', projectDir, (e) => events.push(e));

    // "price: £10" in Windows-1252 — 0xA3 is not a valid UTF-8 start byte.
    const latin1 = Buffer.from([0x70, 0x72, 0x69, 0x63, 0x65, 0x3a, 0x20, 0xa3, 0x31, 0x30]);
    await fs.writeFile(path.join(projectDir, 'latin1.txt'), latin1);
    await new Promise((r) => setTimeout(r, 300));

    const match = events.find((e) => e.path === 'latin1.txt');
    expect(match).toBeDefined();
    // U+FFFD (replacement character) stands in for the undecodable 0xA3.
    expect(match?.content).toBe('price: �10');
  });
});
