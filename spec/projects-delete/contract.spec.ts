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
 *
 * Out of scope:
 *   - Removing deployed metadata from any linked Salesforce org.
 *   - Soft-delete / archive semantics — there is no recovery endpoint.
 *   - Bulk delete.
 *
 * They are the source of truth for this endpoint's external behavior.
 * The AI implementation agent must NOT modify this file.
 *
 * Mock boundary: none. Real filesystem, real Fastify. The project
 * directory under PROJECTS_ROOT is the only persistence layer this
 * endpoint touches, and we want the contract to reflect actual disk I/O.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { createApp } from '../../src/app.js';

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
});
