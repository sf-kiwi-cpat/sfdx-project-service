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
 * SPEC TESTS — Human-guarded contract (SDLC 2026)
 *
 * These tests define the contract for:
 * - GET /v1/projects/:id/fs/events — SSE stream of filesystem change events
 *
 * The endpoint streams real-time `file-added`, `file-changed`, and
 * `file-removed` events for any write to the project directory — regardless
 * of source (agent tool calls, MCP tools, shell commands, manual edits).
 * Downstream consumers (e.g., App Studio UI) subscribe to react to changes.
 *
 * These tests are the source of truth for this endpoint's external behavior.
 * The AI implementation agent must NOT modify this file.
 *
 * No mocks: chokidar watches a real tmp directory; HTTP is real via Fastify.
 * Event timing uses small stability/debounce windows overridden via env.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createApp } from '../../src/app.js';

/**
 * Open a raw SSE connection against the given Fastify app and capture the
 * response stream. Returns helpers to wait for specific events or close the
 * stream. Using `supertest` would buffer until the stream ends, but SSE
 * streams never end on their own — we need incremental parsing.
 */
interface SSEClient {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Wait until an event matching `predicate` arrives. Rejects after timeout. */
  waitForEvent(predicate: (evt: SSEEvent) => boolean, timeoutMs?: number): Promise<SSEEvent>;
  /** Collect all events that arrive within `windowMs`. */
  collectEvents(windowMs: number): Promise<SSEEvent[]>;
  events: SSEEvent[];
  close(): void;
}

interface SSEEvent {
  event: string;
  data: unknown;
}

async function openSSE(app: ReturnType<typeof createApp>, url: string): Promise<SSEClient> {
  await app.ready();
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('app.server has no bound address');
  }
  const port = address.port;

  return new Promise((resolve, reject) => {
    const events: SSEEvent[] = [];
    const waiters: Array<{
      predicate: (evt: SSEEvent) => boolean;
      resolve: (evt: SSEEvent) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }> = [];

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: url,
        method: 'GET',
        headers: { accept: 'text/event-stream' },
      },
      (res) => {
        res.setEncoding('utf8');
        let buffer = '';

        res.on('data', (chunk: string) => {
          buffer += chunk;
          // SSE events are separated by blank lines (\n\n)
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            // Parse the event block
            if (raw.startsWith(':')) continue; // heartbeat/comment
            let eventName = 'message';
            let dataLine = '';
            for (const line of raw.split('\n')) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
            }
            let parsed: unknown = dataLine;
            try {
              parsed = JSON.parse(dataLine);
            } catch {
              /* leave as string */
            }
            const evt: SSEEvent = { event: eventName, data: parsed };
            events.push(evt);
            // Notify any waiter whose predicate matches
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i].predicate(evt)) {
                clearTimeout(waiters[i].timer);
                waiters[i].resolve(evt);
                waiters.splice(i, 1);
              }
            }
          }
        });

        const client: SSEClient = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          events,
          waitForEvent(predicate, timeoutMs = 3000) {
            // Check already-received events first
            const existing = events.find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise((res2, rej2) => {
              const timer = setTimeout(() => {
                const i = waiters.findIndex((w) => w.predicate === predicate);
                if (i >= 0) waiters.splice(i, 1);
                rej2(new Error(`Timed out waiting for SSE event`));
              }, timeoutMs);
              waiters.push({
                predicate,
                resolve: res2,
                reject: rej2,
                timer,
              });
            });
          },
          async collectEvents(windowMs) {
            const start = events.length;
            await new Promise((r) => setTimeout(r, windowMs));
            return events.slice(start);
          },
          close() {
            req.destroy();
            res.destroy();
          },
        };
        resolve(client);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /v1/projects/:id/fs/events', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;
  let projectDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-fs-events-test-'));
    process.env.PROJECTS_ROOT = tmpDir;
    // Shrink the debounce so tests don't have to wait 300ms per event. The
    // production default is 300ms; watcher behaviour is unchanged by the
    // override — only timing.
    process.env.WATCHER_DEBOUNCE_MS = '50';
    // Shrink awaitWriteFinish stability so tests don't wait 200ms per write.
    process.env.WATCHER_STABILITY_MS = '30';
  });

  afterAll(async () => {
    delete process.env.PROJECTS_ROOT;
    delete process.env.WATCHER_DEBOUNCE_MS;
    delete process.env.WATCHER_STABILITY_MS;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    app = createApp();
    // Bind to an ephemeral port so the raw http client can connect for SSE.
    await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await request(app.server)
      .post('/v1/projects')
      .send({ template: 'local-react-test' })
      .expect(201);
    projectId = res.body.id;
    projectDir = path.join(tmpDir, projectId);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('connection', () => {
    it('returns 200 with Content-Type: text/event-stream', async () => {
      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        expect(client.status).toBe(200);
        expect(client.headers['content-type']).toContain('text/event-stream');
      } finally {
        client.close();
      }
    });

    it('returns Cache-Control: no-cache', async () => {
      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        expect(client.headers['cache-control']).toBe('no-cache');
      } finally {
        client.close();
      }
    });

    it('returns Connection: keep-alive', async () => {
      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        expect(client.headers['connection']).toBe('keep-alive');
      } finally {
        client.close();
      }
    });

    it('emits a `connected` event with the projectId on subscription', async () => {
      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        const evt = await client.waitForEvent((e) => e.event === 'connected');
        expect(evt.data).toEqual({ projectId });
      } finally {
        client.close();
      }
    });
  });

  describe('file events', () => {
    it('emits `file-added` with relative path and content on create (text file)', async () => {
      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        await client.waitForEvent((e) => e.event === 'connected');
        await fs.writeFile(path.join(projectDir, 'hello.txt'), 'hello world');

        const evt = await client.waitForEvent(
          (e) => e.event === 'file-added' && (e.data as { path: string }).path === 'hello.txt'
        );
        expect(evt.data).toMatchObject({
          path: 'hello.txt',
          type: 'add',
          content: 'hello world',
        });
      } finally {
        client.close();
      }
    });

    it('emits `file-changed` with relative path and updated content on modify', async () => {
      // Pre-create the file before subscribing so the initial add is ignored
      const target = path.join(projectDir, 'change-me.txt');
      await fs.writeFile(target, 'original');

      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        await client.waitForEvent((e) => e.event === 'connected');
        await fs.writeFile(target, 'updated');

        const evt = await client.waitForEvent(
          (e) => e.event === 'file-changed' && (e.data as { path: string }).path === 'change-me.txt'
        );
        expect(evt.data).toMatchObject({
          path: 'change-me.txt',
          type: 'change',
          content: 'updated',
        });
      } finally {
        client.close();
      }
    });

    it('emits `file-removed` with relative path and no content on delete', async () => {
      const target = path.join(projectDir, 'delete-me.txt');
      await fs.writeFile(target, 'doomed');

      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        await client.waitForEvent((e) => e.event === 'connected');
        await fs.unlink(target);

        const evt = await client.waitForEvent(
          (e) => e.event === 'file-removed' && (e.data as { path: string }).path === 'delete-me.txt'
        );
        const data = evt.data as { path: string; type: string; content?: string };
        expect(data.path).toBe('delete-me.txt');
        expect(data.type).toBe('unlink');
        expect(data.content).toBeUndefined();
      } finally {
        client.close();
      }
    });

    it('reports nested directory paths relative to the project root', async () => {
      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        await client.waitForEvent((e) => e.event === 'connected');
        const nested = path.join(projectDir, 'src', 'components', 'App.js');
        await fs.mkdir(path.dirname(nested), { recursive: true });
        await fs.writeFile(nested, 'export default function App() {}');

        const evt = await client.waitForEvent(
          (e) =>
            e.event === 'file-added' &&
            (e.data as { path: string }).path === 'src/components/App.js'
        );
        expect(evt.data).toMatchObject({
          path: 'src/components/App.js',
          type: 'add',
          content: 'export default function App() {}',
        });
      } finally {
        client.close();
      }
    });

    it.each([
      ['image.png'],
      ['photo.jpg'],
      ['anim.gif'],
      ['modern.webp'],
      ['doc.pdf'],
      ['bundle.zip'],
      ['font.woff'],
      ['font.woff2'],
      ['font.ttf'],
    ])('omits content for binary extensions (%s)', async (filename) => {
      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        await client.waitForEvent((e) => e.event === 'connected');
        // Arbitrary non-empty bytes — the classifier must decide by extension,
        // not content sniffing
        const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
        await fs.writeFile(path.join(projectDir, filename), bytes);

        const evt = await client.waitForEvent(
          (e) => e.event === 'file-added' && (e.data as { path: string }).path === filename
        );
        const data = evt.data as { path: string; type: string; content?: string };
        expect(data.path).toBe(filename);
        expect(data.type).toBe('add');
        expect(data.content).toBeUndefined();
      } finally {
        client.close();
      }
    });

    it('omits content for text files larger than 100KB', async () => {
      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        await client.waitForEvent((e) => e.event === 'connected');
        // 120KB of 'a' — above the 100KB cutoff
        const big = 'a'.repeat(120 * 1024);
        await fs.writeFile(path.join(projectDir, 'big.txt'), big);

        const evt = await client.waitForEvent(
          (e) => e.event === 'file-added' && (e.data as { path: string }).path === 'big.txt'
        );
        const data = evt.data as { path: string; type: string; content?: string };
        expect(data.path).toBe('big.txt');
        expect(data.type).toBe('add');
        expect(data.content).toBeUndefined();
      } finally {
        client.close();
      }
    });

    it('debounces rapid writes to the same path into a single event with the latest content', async () => {
      const target = path.join(projectDir, 'rapid.txt');
      await fs.writeFile(target, 'v0');

      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        await client.waitForEvent((e) => e.event === 'connected');
        // Several writes inside one debounce window
        await fs.writeFile(target, 'v1');
        await fs.writeFile(target, 'v2');
        await fs.writeFile(target, 'v3');

        // Wait past the debounce window and collect everything that landed
        await new Promise((r) => setTimeout(r, 300));
        const rapidEvents = client.events.filter(
          (e) =>
            (e.event === 'file-added' || e.event === 'file-changed') &&
            (e.data as { path: string }).path === 'rapid.txt'
        );
        expect(rapidEvents.length).toBe(1);
        expect((rapidEvents[0].data as { content: string }).content).toBe('v3');
      } finally {
        client.close();
      }
    });
  });

  describe('ignored paths', () => {
    it('does not emit events for dotfiles', async () => {
      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        await client.waitForEvent((e) => e.event === 'connected');
        await fs.writeFile(path.join(projectDir, '.hidden'), 'x');
        await fs.writeFile(path.join(projectDir, '.env'), 'SECRET=1');

        const newEvents = await client.collectEvents(250);
        const fileEvents = newEvents.filter((e) => e.event.startsWith('file-'));
        expect(fileEvents).toEqual([]);
      } finally {
        client.close();
      }
    });

    it('does not emit events for node_modules/', async () => {
      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        await client.waitForEvent((e) => e.event === 'connected');
        const nm = path.join(projectDir, 'node_modules', 'pkg');
        await fs.mkdir(nm, { recursive: true });
        await fs.writeFile(path.join(nm, 'index.js'), 'module.exports = {}');

        const newEvents = await client.collectEvents(250);
        const fileEvents = newEvents.filter((e) => e.event.startsWith('file-'));
        expect(fileEvents).toEqual([]);
      } finally {
        client.close();
      }
    });

    it('does not emit events for .git/', async () => {
      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        await client.waitForEvent((e) => e.event === 'connected');
        const git = path.join(projectDir, '.git');
        await fs.mkdir(git, { recursive: true });
        await fs.writeFile(path.join(git, 'HEAD'), 'ref: refs/heads/main');

        const newEvents = await client.collectEvents(250);
        const fileEvents = newEvents.filter((e) => e.event.startsWith('file-'));
        expect(fileEvents).toEqual([]);
      } finally {
        client.close();
      }
    });

    it('does not emit events for .sf/', async () => {
      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        await client.waitForEvent((e) => e.event === 'connected');
        const sf = path.join(projectDir, '.sf');
        await fs.mkdir(sf, { recursive: true });
        await fs.writeFile(path.join(sf, 'state.json'), '{}');

        const newEvents = await client.collectEvents(250);
        const fileEvents = newEvents.filter((e) => e.event.startsWith('file-'));
        expect(fileEvents).toEqual([]);
      } finally {
        client.close();
      }
    });

    it('does not emit events for .project-meta.json', async () => {
      // This file is written by the project creation machinery; re-writing
      // it must not leak into the public change stream.
      const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        await client.waitForEvent((e) => e.event === 'connected');
        await fs.writeFile(path.join(projectDir, '.project-meta.json'), '{"x":1}');

        const newEvents = await client.collectEvents(250);
        const fileEvents = newEvents.filter((e) => e.event.startsWith('file-'));
        expect(fileEvents).toEqual([]);
      } finally {
        client.close();
      }
    });
  });

  describe('errors (RFC 9457)', () => {
    it('returns 404 when the project ID does not exist', async () => {
      const res = await request(app.server)
        .get('/v1/projects/00000000-0000-0000-0000-000000000000/fs/events')
        .expect(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
    });

    it('returns 404 when the project ID is not a valid UUID', async () => {
      const res = await request(app.server).get('/v1/projects/not-a-uuid/fs/events').expect(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
    });
  });

  describe('lifecycle', () => {
    it('delivers the same event to two concurrent subscribers on the same project', async () => {
      const a = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      const b = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        await a.waitForEvent((e) => e.event === 'connected');
        await b.waitForEvent((e) => e.event === 'connected');

        await fs.writeFile(path.join(projectDir, 'shared.txt'), 'shared');

        const evtA = await a.waitForEvent(
          (e) => e.event === 'file-added' && (e.data as { path: string }).path === 'shared.txt'
        );
        const evtB = await b.waitForEvent(
          (e) => e.event === 'file-added' && (e.data as { path: string }).path === 'shared.txt'
        );
        expect(evtA.data).toMatchObject({ path: 'shared.txt', content: 'shared' });
        expect(evtB.data).toMatchObject({ path: 'shared.txt', content: 'shared' });
      } finally {
        a.close();
        b.close();
      }
    });

    it('re-subscribing after the last subscriber disconnects still works correctly', async () => {
      // First subscriber — establishes the watcher
      const first = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      await first.waitForEvent((e) => e.event === 'connected');
      await fs.writeFile(path.join(projectDir, 'first.txt'), 'first');
      await first.waitForEvent(
        (e) => e.event === 'file-added' && (e.data as { path: string }).path === 'first.txt'
      );
      first.close();
      // Give the server a beat to tear down the underlying watcher
      await new Promise((r) => setTimeout(r, 150));

      // Second subscriber — must see events from a freshly-rebuilt watcher
      const second = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
      try {
        await second.waitForEvent((e) => e.event === 'connected');
        await fs.writeFile(path.join(projectDir, 'second.txt'), 'second');
        const evt = await second.waitForEvent(
          (e) => e.event === 'file-added' && (e.data as { path: string }).path === 'second.txt'
        );
        expect(evt.data).toMatchObject({
          path: 'second.txt',
          type: 'add',
          content: 'second',
        });
      } finally {
        second.close();
      }
    });
  });
});
