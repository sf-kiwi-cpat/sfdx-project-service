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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createApp } from '../../src/app.js';

/**
 * Read just the response headers for an SSE endpoint and close immediately.
 * supertest would buffer the stream forever — we need a raw request to grab
 * headers and abort before the stream starts flowing.
 */
async function readResponseHeaders(
  app: ReturnType<typeof createApp>,
  url: string,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  await app.ready();
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('app.server has no bound address');
  }
  const port = address.port;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: url,
        method: 'GET',
        headers: { accept: 'text/event-stream', ...extraHeaders },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers = res.headers;
        req.destroy();
        res.destroy();
        resolve({ status, headers });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('fs-events routes integration — SSE response headers', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-fs-events-routes-'));
    process.env.PROJECTS_ROOT = tmpDir;
    // Keep timers small so the test stays fast even though we don't exercise
    // the stream body.
    process.env.WATCHER_DEBOUNCE_MS = '200';
    process.env.WATCHER_STABILITY_MS = '30';

    app = createApp();
    await app.listen({ port: 0, host: '127.0.0.1' });

    const createRes = await request(app.server).post('/v1/projects').send({});
    projectId = createRes.body.id;
  });

  afterEach(async () => {
    delete process.env.PROJECTS_ROOT;
    delete process.env.WATCHER_DEBOUNCE_MS;
    delete process.env.WATCHER_STABILITY_MS;
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('echoes the request Origin in Access-Control-Allow-Origin so browsers permit cross-origin EventSource subscriptions', async () => {
    // @fastify/cors runs in the Fastify response pipeline with `origin: true`
    // (see src/app.ts). Since @fastify/sse does not hijack the reply, the
    // CORS plugin now runs on SSE routes the same as any other — a real
    // browser `EventSource` sends `Origin` and gets it echoed back,
    // unblocking the cross-origin subscription.
    const origin = 'https://app.example.com';
    const { status, headers } = await readResponseHeaders(
      app,
      `/v1/projects/${projectId}/fs/events`,
      { origin }
    );

    expect(status).toBe(200);
    expect(headers['access-control-allow-origin']).toBe(origin);
  });
});
