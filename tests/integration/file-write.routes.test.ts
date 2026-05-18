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

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createApp } from '../../src/app.js';

interface SSEEvent {
  event: string;
  data: unknown;
}

interface SSEClient {
  waitForEvent(predicate: (evt: SSEEvent) => boolean, timeoutMs?: number): Promise<SSEEvent>;
  events: SSEEvent[];
  close(): void;
}

/**
 * Open a raw SSE connection. supertest buffers the stream forever, but SSE
 * never ends on its own — we need incremental parsing. Lifted from the
 * pattern in `spec/fs-events/contract.spec.ts`.
 */
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
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (raw.startsWith(':')) continue;
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
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i].predicate(evt)) {
                clearTimeout(waiters[i].timer);
                waiters[i].resolve(evt);
                waiters.splice(i, 1);
              }
            }
          }
        });

        resolve({
          events,
          waitForEvent(predicate, timeoutMs = 3000) {
            const existing = events.find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise((res2, rej2) => {
              const timer = setTimeout(() => {
                const i = waiters.findIndex((w) => w.predicate === predicate);
                if (i >= 0) waiters.splice(i, 1);
                rej2(new Error('Timed out waiting for SSE event'));
              }, timeoutMs);
              waiters.push({ predicate, resolve: res2, timer });
            });
          },
          close() {
            req.destroy();
            res.destroy();
          },
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('PUT /v1/projects/:id/file — watcher integration', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-file-write-watcher-'));
    process.env.PROJECTS_ROOT = tmpDir;
    // Shrink the debounce/stability windows so events surface fast in tests.
    process.env.WATCHER_DEBOUNCE_MS = '200';
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
    // Bind to an ephemeral port so the raw http client can subscribe to SSE.
    await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await request(app.server)
      .post('/v1/projects')
      .send({ template: 'local-react-test' })
      .expect(201);
    projectId = res.body.id;
  });

  afterEach(async () => {
    await app.close();
  });

  it('emits an `fs.file.changed` SSE event after a PUT overwrites an existing file', async () => {
    // Pre-create the file so the watcher's initial scan picks it up before we
    // subscribe — otherwise the first event would be `add`, not `change`.
    const projectDir = path.join(tmpDir, projectId);
    const target = path.join(projectDir, 'live-edit.txt');
    await fs.writeFile(target, 'before');

    const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
    try {
      await client.waitForEvent((e) => e.event === 'connected');

      await request(app.server)
        .put(`/v1/projects/${projectId}/file`)
        .send({ path: 'live-edit.txt', content: 'after' })
        .expect(204);

      const evt = await client.waitForEvent(
        (e) => e.event === 'file-changed' && (e.data as { path: string }).path === 'live-edit.txt'
      );
      expect(evt.data).toMatchObject({
        path: 'live-edit.txt',
        type: 'change',
        content: 'after',
      });
    } finally {
      client.close();
    }
  });

  it('emits an `fs.file.added` SSE event after a PUT creates a new file', async () => {
    const client = await openSSE(app, `/v1/projects/${projectId}/fs/events`);
    try {
      await client.waitForEvent((e) => e.event === 'connected');

      await request(app.server)
        .put(`/v1/projects/${projectId}/file`)
        .send({ path: 'new-file.txt', content: 'fresh' })
        .expect(204);

      const evt = await client.waitForEvent(
        (e) => e.event === 'file-added' && (e.data as { path: string }).path === 'new-file.txt'
      );
      expect(evt.data).toMatchObject({
        path: 'new-file.txt',
        type: 'add',
        content: 'fresh',
      });
    } finally {
      client.close();
    }
  });
});
