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
 * Contract: the API rejects request bodies that contain properties not
 * defined in the route's body schema. Closes #178.
 *
 * Motivation: silently dropping unknown properties hides caller mistakes.
 * A consumer that POSTs `{ name: "my-project", template: "minimal" }` to
 * POST /v1/projects expecting the `name` field to take effect currently
 * gets 201 back with an auto-generated name. A 400 surfaces the typo or
 * misunderstanding immediately.
 *
 * Scope:
 *   - Applies to every endpoint whose route declares a body schema.
 *   - Covered here: POST /v1/projects and PATCH /v1/projects/:id (the
 *     two body-accepting endpoints with schemas today).
 *   - Endpoints without a body schema (e.g. the deployments POST) are
 *     out of scope — this contract governs schema-validated bodies, not
 *     whether a route should add a schema.
 *
 * Error shape: responses follow the project's existing RFC 9457
 * problem-detail shape ({ status, title, detail }) served as
 * application/problem+json. The detail string names the offending
 * property so callers can identify the typo without a schema reference.
 *
 * Valid requests (no unknown properties) must continue to succeed — the
 * fix must not introduce a regression for well-formed callers.
 *
 * The AI implementation agent must NOT modify this file.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../src/app.js';

describe('Reject unknown request body properties', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-reject-unknown-test-'));
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

  describe('POST /v1/projects', () => {
    it('returns 400 when the body contains an unknown property', async () => {
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'local-react-test', name: 'my-project' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
      expect(res.body.title).toBe('Bad Request');
      expect(typeof res.body.detail).toBe('string');
      expect(res.body.detail).toContain('name');
    });

    it('returns 400 when the body contains an unknown property on an otherwise empty body', async () => {
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ unexpected: 'value' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
      expect(res.body.detail).toContain('unexpected');
    });

    it('does not create a project when the body has an unknown property', async () => {
      await request(app.server)
        .post('/v1/projects')
        .send({ template: 'local-react-test', name: 'my-project' })
        .expect(400);

      const list = await request(app.server).get('/v1/projects').expect(200);
      expect(list.body).toEqual([]);
    });

    it('still accepts a valid body with only known properties', async () => {
      await request(app.server)
        .post('/v1/projects')
        .send({ template: 'local-react-test' })
        .expect(201);
    });

    it('still accepts an empty body', async () => {
      await request(app.server).post('/v1/projects').send({}).expect(201);
    });
  });

  describe('PATCH /v1/projects/:id', () => {
    it('returns 400 when the body contains an unknown property', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: 'renamed', extraField: 'value' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
      expect(res.body.title).toBe('Bad Request');
      expect(typeof res.body.detail).toBe('string');
      expect(res.body.detail).toContain('extraField');
    });

    it('does not rename the project when the body has an unknown property', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);
      const originalName = createRes.body.name;

      await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: 'renamed', extraField: 'value' })
        .expect(400);

      const list = await request(app.server).get('/v1/projects').expect(200);
      const project = list.body.find((p: { id: string }) => p.id === createRes.body.id);
      expect(project.name).toBe(originalName);
    });

    it('still accepts a valid body with only known properties', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: 'valid-rename' })
        .expect(200);
    });
  });
});
