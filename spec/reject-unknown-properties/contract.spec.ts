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
 *   - Applies to every endpoint that declares (or must declare) a body
 *     schema.
 *   - Covered here: POST /v1/projects and PATCH /v1/projects/:id.
 *     POST /v1/projects already declares a body schema today. PATCH
 *     /v1/projects/:id does NOT yet declare one — it validates `name`
 *     imperatively inside the handler. Satisfying this contract requires
 *     the implementation to add a body schema to PATCH so Ajv can
 *     enforce `additionalProperties: false`. PATCH is therefore listed
 *     above because this contract forces it to gain a schema.
 *   - Endpoints that do not declare a body schema (e.g. the deployments
 *     POST) are out of scope — this contract governs schema-validated
 *     bodies, not whether a route should add a schema. The PATCH
 *     clarification above is the one exception: this contract prescribes
 *     that PATCH gain a schema as part of adoption.
 *   - Non-object request bodies (JSON arrays, strings, numbers, null)
 *     are out of scope. `Type.Object(...)` already rejects them with a
 *     400 via Fastify's type validator; the precise wording of that
 *     400 is not pinned by this contract.
 *
 * Error shape: responses follow the project's existing RFC 9457
 * problem-detail shape ({ status, title, detail }) served as
 * application/problem+json. The detail string names the offending
 * property so callers can identify the typo without a schema reference.
 *
 * Valid requests (no unknown properties) must continue to succeed — the
 * fix must not introduce a regression for well-formed callers.
 *
 * Fixture note: the negative (400) tests in this file intentionally
 * avoid the template resolution path. Schema validation fires before
 * template lookup, so the 400 tests all pass in a bare checkout without
 * `npm run build` first. Only the positive 201 tests that send
 * `{ template: 'local-react-test' }` depend on the local test template
 * being built.
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
      // 'name' is a common word that could appear in unrelated error
      // strings; require the schema-validation quoted form and either
      // 'additional' or 'unknown' boilerplate so a stray
      // template-validation message that happens to contain "name"
      // can't satisfy this assertion.
      expect(res.body.detail).toContain("'name'");
      expect(res.body.detail).toMatch(/additional|unknown/i);
    });

    it('names only one unknown property when multiple are present', async () => {
      // Ajv default (allErrors: false) reports only the first error,
      // which pins the UX: callers see one offending key per 400 and
      // fix them incrementally. This test prevents a future switch to
      // `allErrors: true` (or equivalent) that would silently broaden
      // the contract to mention every unknown key at once. The test
      // does not pin *which* key is named — Ajv's order of checks is
      // an implementation detail of the validator — only that exactly
      // one is named.
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ firstUnknownKey: 1, secondUnknownKey: 2 })
        .expect(400);

      expect(res.body.status).toBe(400);
      const namesFirst = res.body.detail.includes('firstUnknownKey');
      const namesSecond = res.body.detail.includes('secondUnknownKey');
      // Exactly one — not both, not neither.
      expect(namesFirst !== namesSecond).toBe(true);
    });

    it('returns 400 when the body contains a coined unknown property on an otherwise empty body', async () => {
      // Use a coined token (unlikely to appear in any unrelated error
      // message) so the assertion pins schema-validation behavior
      // rather than accidentally matching other 400 paths.
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ sproingyWidget: 'value' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
      expect(res.body.detail).toContain('sproingyWidget');
      expect(res.body.detail).toMatch(/additional|unknown/i);
    });

    it('does not create a project when the body has an unknown property', async () => {
      // Capture the list before the rejected POST so the assertion is
      // independent of test order and any shared PROJECTS_ROOT state
      // from sibling tests (or describe blocks added later).
      const before = await request(app.server).get('/v1/projects').expect(200);

      await request(app.server)
        .post('/v1/projects')
        .send({ template: 'local-react-test', name: 'my-project' })
        .expect(400);

      const after = await request(app.server).get('/v1/projects').expect(200);
      expect(after.body).toEqual(before.body);
    });

    it('rejects a case-variant of a known property as unknown', async () => {
      // `Template` (capitalised) is a realistic typo that must NOT be
      // silently accepted or case-folded to `template`. The unknown-
      // property check is case-sensitive, which is the JSON Schema
      // default for `additionalProperties: false`.
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ Template: 'local-react-test' })
        .expect(400);

      expect(res.body.status).toBe(400);
      expect(res.body.detail).toContain('Template');
      expect(res.body.detail).toMatch(/additional|unknown/i);
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

    it('treats orgAlias as a known property (regression guard)', async () => {
      // `orgAlias` is a legitimate POST property today. If the schema is
      // mis-configured (e.g. orgAlias left out of the Type.Object), it
      // would be rejected as an unknown property instead of triggering
      // the normal "alias not found" path. This test pins that the
      // contract does not accidentally add orgAlias to the unknown list.
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ orgAlias: 'nonexistent-alias-abc123' })
        .expect(400);

      expect(res.body.status).toBe(400);
      // The failure must be about the alias not being found, NOT about
      // the schema rejecting `orgAlias` as an additional property.
      expect(res.body.detail).not.toMatch(/additional properties/i);
      expect(res.body.detail).not.toContain("'orgAlias'");
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

    it('returns 400 naming the unknown property when the body has only an unknown property and no name', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ wrongField: 'x' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
      expect(res.body.title).toBe('Bad Request');
      expect(typeof res.body.detail).toBe('string');
      // The additionalProperties check must fire before the "name required"
      // check, so a typo like { wrongField: 'x' } surfaces the unknown
      // property name — not a generic "name is required" message.
      expect(res.body.detail).toContain('wrongField');
      expect(res.body.detail).not.toContain('name is required');
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
