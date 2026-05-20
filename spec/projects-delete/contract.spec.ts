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
 * Contract for DELETE /v1/projects/:id — removes a project's directory
 * from disk. No org-side cleanup: any metadata previously deployed to a
 * linked org is left in place. This matches the project model: projects
 * are local-disk artifacts and the API never claims ownership of remote
 * org state.
 *
 * Endpoint:
 *   - DELETE /v1/projects/:id — delete a project from disk
 *
 * Status codes:
 *   - 204 No Content — project existed and was removed; response body is empty
 *   - 404 Not Found  — id does not resolve to an existing project
 *                      (RFC 9457 application/problem+json). Symmetric with
 *                      GET /:id and PATCH /:id: a non-UUID id and a
 *                      well-formed UUID that is not present both return
 *                      404 (no information leak about id format).
 *
 * Idempotency:
 *   A second DELETE on the same id returns 404, mirroring GET /:id and
 *   PATCH /:id. Callers that want "delete-or-noop" semantics can ignore
 *   404 client-side. We pick strict 404 over idempotent 204 because:
 *     - It matches every other /:id route (no per-route surprise).
 *     - It distinguishes "I successfully deleted N projects" from "I
 *       attempted N deletes" — useful for UIs that show batch results.
 *
 * Side effects:
 *   - The project's directory under PROJECTS_ROOT is removed entirely.
 *   - The project no longer appears in GET /v1/projects.
 *   - Subsequent GET /v1/projects/:id, PATCH /v1/projects/:id,
 *     GET /v1/projects/:id/tree, and GET /v1/projects/:id/file return 404.
 *   - Sibling projects are untouched. Deleting one project never affects
 *     another's directory or metadata.
 *   - Any in-flight Server-Sent Events stream for the deleted project
 *     (`GET /v1/projects/:id/fs/events`) is forcibly closed by the server
 *     before DELETE returns 204. The underlying chokidar watcher for the
 *     deleted project is torn down so no further filesystem events are
 *     processed for that id (no resource leak). A reconnecting client
 *     will hit 404 on the next subscribe and stop.
 *
 * Out of scope:
 *   - Removing deployed metadata from any linked Salesforce org.
 *   - Soft-delete / archive semantics — there is no recovery endpoint.
 *   - Bulk delete.
 *   - Deployment SSE streams (`/v1/projects/:id/deployments/:deploymentId/events`)
 *     — those are deployment-id keyed and their lifetime is governed by
 *     the deployment record, not by the project directory. A deploy worker
 *     whose project dir disappears will fail naturally and emit a final
 *     `complete` event with the failure.
 *
 * They are the source of truth for this endpoint's external behavior.
 * The AI implementation agent must NOT modify this file.
 *
 * Mock boundary: none. Real filesystem, real Fastify, real chokidar.
 * The project directory under PROJECTS_ROOT is the only persistence
 * layer this endpoint touches, and we want the contract to reflect
 * actual disk I/O and actual SSE socket behavior.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { createApp } from '../../src/app.js';

/**
 * Minimal raw SSE client used by the SSE-teardown tests. Mirrors the
 * helper in spec/fs-events/contract.spec.ts but trimmed to only what
 * these tests need: track received events, surface stream-close, and
 * allow the test to close the request from the client side.
 */
interface SSEClient {
  status: number;
  headers: http.IncomingHttpHeaders;
  events: Array<{ event: string; data: unknown }>;
  /** Resolves once the underlying HTTP response has emitted `end`/`close`. */
  closed: Promise<void>;
  waitForEvent(predicate: (evt: { event: string }) => boolean, timeoutMs?: number): Promise<void>;
  close(): void;
}

async function openSSE(app: ReturnType<typeof createApp>, url: string): Promise<SSEClient> {
  await app.ready();
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('app.server has no bound address');
  }
  const port = address.port;

  return new Promise((resolve, reject) => {
    const events: Array<{ event: string; data: unknown }> = [];
    const waiters: Array<{
      predicate: (evt: { event: string }) => boolean;
      resolve: () => void;
      timer: NodeJS.Timeout;
    }> = [];

    let closeResolve: () => void;
    const closed = new Promise<void>((r) => {
      closeResolve = r;
    });

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
            const evt = { event: eventName, data: parsed };
            events.push(evt);
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i].predicate(evt)) {
                clearTimeout(waiters[i].timer);
                waiters[i].resolve();
                waiters.splice(i, 1);
              }
            }
          }
        });

        const onEnd = (): void => closeResolve();
        res.on('end', onEnd);
        res.on('close', onEnd);

        const client: SSEClient = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          events,
          closed,
          waitForEvent(predicate, timeoutMs = 3000) {
            const existing = events.find(predicate);
            if (existing) return Promise.resolve();
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
        };
        resolve(client);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('DELETE /v1/projects/:id', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-projects-delete-test-'));
    process.env.PROJECTS_ROOT = tmpDir;
  });

  afterAll(async () => {
    delete process.env.PROJECTS_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    app = createApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('success path', () => {
    it('returns 204 No Content with an empty body for an existing project', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server).delete(`/v1/projects/${createRes.body.id}`).expect(204);

      // 204 means no body. supertest exposes the body as an empty object
      // when there is none; assert against the raw text payload as well
      // so we catch implementations that send a JSON body with status 204.
      expect(res.text).toBe('');
    });

    it('removes the project directory from disk', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);
      const projectDir = path.join(tmpDir, createRes.body.id);

      // Sanity check: directory exists before delete.
      const before = await fs.stat(projectDir);
      expect(before.isDirectory()).toBe(true);

      await request(app.server).delete(`/v1/projects/${createRes.body.id}`).expect(204);

      let exists = true;
      try {
        await fs.access(projectDir);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });

    it('removes a project that has nested files (template-based project)', async () => {
      const createRes = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'local-react-test' })
        .expect(201);
      const projectDir = path.join(tmpDir, createRes.body.id);

      // Sanity: template projects have non-trivial nested content.
      const entries = await fs.readdir(projectDir);
      expect(entries.length).toBeGreaterThan(0);

      await request(app.server).delete(`/v1/projects/${createRes.body.id}`).expect(204);

      let exists = true;
      try {
        await fs.access(projectDir);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });

    it('removes the project from GET /v1/projects', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      await request(app.server).delete(`/v1/projects/${createRes.body.id}`).expect(204);

      const listRes = await request(app.server).get('/v1/projects').expect(200);
      const ids = listRes.body.map((p: { id: string }) => p.id);
      expect(ids).not.toContain(createRes.body.id);
    });

    it('subsequent GET /v1/projects/:id returns 404', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      await request(app.server).delete(`/v1/projects/${createRes.body.id}`).expect(204);

      const res = await request(app.server).get(`/v1/projects/${createRes.body.id}`).expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
    });

    it('subsequent PATCH /v1/projects/:id returns 404', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      await request(app.server).delete(`/v1/projects/${createRes.body.id}`).expect(204);

      const res = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: 'should-fail' })
        .expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
    });

    it('subsequent GET /v1/projects/:id/tree returns 404', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      await request(app.server).delete(`/v1/projects/${createRes.body.id}`).expect(204);

      const res = await request(app.server)
        .get(`/v1/projects/${createRes.body.id}/tree`)
        .expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
    });
  });

  describe('error cases', () => {
    it('returns 404 Problem Detail for a valid UUID that does not exist', async () => {
      const missingId = randomUUID();

      const res = await request(app.server).delete(`/v1/projects/${missingId}`).expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
      expect(res.body).toHaveProperty('title');
    });

    it('returns 404 Problem Detail when the id is not a UUID', async () => {
      const res = await request(app.server).delete('/v1/projects/not-a-uuid').expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
      expect(res.body).toHaveProperty('title');
    });

    it('returns 404 Problem Detail for an id containing path-traversal segments', async () => {
      // Path-traversal ids must never resolve to anything outside PROJECTS_ROOT.
      // Symmetric with GET /:id — any disallowed id surfaces as 404, not 400,
      // so callers cannot probe for the existence of arbitrary paths.
      const res = await request(app.server).delete('/v1/projects/..%2Fetc').expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
    });

    it('a second delete of the same id returns 404 (not idempotent 204)', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      await request(app.server).delete(`/v1/projects/${createRes.body.id}`).expect(204);

      const res = await request(app.server).delete(`/v1/projects/${createRes.body.id}`).expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
    });
  });

  describe('isolation', () => {
    it('deleting one project does not affect a sibling project', async () => {
      const r1 = await request(app.server).post('/v1/projects').send({}).expect(201);
      const r2 = await request(app.server).post('/v1/projects').send({}).expect(201);

      await request(app.server).delete(`/v1/projects/${r1.body.id}`).expect(204);

      // r2 is still listable, retrievable, and on disk.
      const listRes = await request(app.server).get('/v1/projects').expect(200);
      const ids = listRes.body.map((p: { id: string }) => p.id);
      expect(ids).toContain(r2.body.id);
      expect(ids).not.toContain(r1.body.id);

      const getRes = await request(app.server).get(`/v1/projects/${r2.body.id}`).expect(200);
      expect(getRes.body.id).toBe(r2.body.id);

      const r2Dir = path.join(tmpDir, r2.body.id);
      const stat = await fs.stat(r2Dir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  /**
   * The fs-events SSE endpoint (`GET /v1/projects/:id/fs/events`) holds
   * a per-project chokidar watcher for as long as any subscriber is
   * connected. Without explicit teardown, DELETE leaks both the watcher
   * (an FD + listener registration) and any open SSE sockets — the
   * client's HTTP connection stays open serving an event stream that
   * will never produce another event.
   *
   * These tests pin the contract: DELETE forcibly tears down the
   * watcher and closes any active subscriber's stream before the 204
   * is returned. Sibling projects' streams are untouched.
   *
   * Real Fastify + raw http SSE client (no mocks) — the only way to
   * verify socket-level close behavior. Tests bind the app to an
   * ephemeral port for the SSE path; non-SSE tests above continue to
   * use supertest against `app.server` without listen().
   */
  describe('SSE teardown on delete', () => {
    let sseApp: ReturnType<typeof createApp>;

    beforeEach(async () => {
      // Override the watcher debounce so tests don't pay 300ms per event;
      // we don't need filesystem events to fire in these tests, but the
      // watcher startup path still reads this var.
      process.env.WATCHER_DEBOUNCE_MS = '50';
      sseApp = createApp();
      await sseApp.listen({ port: 0, host: '127.0.0.1' });
    });

    afterEach(async () => {
      await sseApp.close();
      delete process.env.WATCHER_DEBOUNCE_MS;
    });

    it('closes an active fs-events SSE subscriber when the project is deleted', async () => {
      const createRes = await request(sseApp.server).post('/v1/projects').send({}).expect(201);
      const projectId: string = createRes.body.id;

      const client = await openSSE(sseApp, `/v1/projects/${projectId}/fs/events`);
      try {
        // Wait for the connected event — proves the watcher is attached
        // and the subscription is live before we delete.
        await client.waitForEvent((e) => e.event === 'connected');

        await request(sseApp.server).delete(`/v1/projects/${projectId}`).expect(204);

        // The server must end the stream as part of DELETE. Bound the
        // wait so a leaked socket fails the test loudly rather than
        // hanging the suite.
        await Promise.race([
          client.closed,
          new Promise((_, rej) =>
            setTimeout(
              () => rej(new Error('SSE connection was not closed by DELETE within 3s')),
              3000
            )
          ),
        ]);
      } finally {
        client.close();
      }
    });

    it('does not produce further filesystem events for the deleted project', async () => {
      // Proxy for "the watcher was torn down": after DELETE, even if the
      // chokidar watcher were still alive against the (now removed)
      // project directory, no real events will fire — but a brand-new
      // SSE subscribe against the deleted id must 404, not silently
      // attach to a stale watcher entry.
      const createRes = await request(sseApp.server).post('/v1/projects').send({}).expect(201);
      const projectId: string = createRes.body.id;

      // Open and close a subscriber so the watcher entry is created and
      // then refcounted down to zero (any teardown bug would still leave
      // the entry in the manager's map if not explicitly cleared on
      // delete; this test catches that case once a re-subscribe lands).
      const warmUp = await openSSE(sseApp, `/v1/projects/${projectId}/fs/events`);
      await warmUp.waitForEvent((e) => e.event === 'connected');
      warmUp.close();

      await request(sseApp.server).delete(`/v1/projects/${projectId}`).expect(204);

      // A re-subscribe after delete must hit 404 (project no longer
      // exists) — preHandler validates the project before the SSE
      // wrapper commits headers, so this is the documented behavior of
      // the fs-events route.
      const reRes = await request(sseApp.server)
        .get(`/v1/projects/${projectId}/fs/events`)
        .set('Accept', 'text/event-stream')
        .expect(404);
      expect(reRes.headers['content-type']).toContain('application/problem+json');
    });

    it('returns 204 even when no SSE subscribers are connected', async () => {
      // The teardown path must be a no-op when no watcher exists for the
      // project. Don't gate DELETE on "is anyone subscribed?" — that's a
      // race the client can't help us win.
      const createRes = await request(sseApp.server).post('/v1/projects').send({}).expect(201);

      await request(sseApp.server).delete(`/v1/projects/${createRes.body.id}`).expect(204);
    });

    it("does not close a sibling project's active SSE subscriber", async () => {
      const r1 = await request(sseApp.server).post('/v1/projects').send({}).expect(201);
      const r2 = await request(sseApp.server).post('/v1/projects').send({}).expect(201);

      const sibling = await openSSE(sseApp, `/v1/projects/${r2.body.id}/fs/events`);
      try {
        await sibling.waitForEvent((e) => e.event === 'connected');

        await request(sseApp.server).delete(`/v1/projects/${r1.body.id}`).expect(204);

        // The sibling's stream must still be open ~250ms after the
        // unrelated delete — bounded wait so the test fails fast if the
        // implementation tears down too aggressively.
        const stillOpen = await Promise.race([
          sibling.closed.then(() => false),
          new Promise<boolean>((res) => setTimeout(() => res(true), 250)),
        ]);
        expect(stillOpen).toBe(true);
      } finally {
        sibling.close();
      }
    });
  });
});
