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
 * These tests define the contract for the Projects API:
 *   - POST /projects        — create a project (returns id + name + lastAccessedAt, + initialMessages when template defines them, + targetOrg when orgAlias is provided)
 *   - GET /projects          — list all projects (id + name + lastAccessedAt)
 *   - GET /projects/:id      — retrieve a project by ID (id + name + lastAccessedAt, + initialMessages when present)
 *   - PATCH /projects/:id    — rename a project (returns id + name + lastAccessedAt)
 *   - GET /projects/:id/tree — file tree for a project
 *
 * Every response that references a project includes lastAccessedAt. Create and
 * rename operations bump it; accessing a project by :id (GET, PATCH, tree, file)
 * also updates it. A freshly created project's lastAccessedAt equals its
 * creation time. That "every access bumps" invariant applies only to projects
 * with a valid meta file on disk — see the "meta file integrity" block below
 * for the narrow carve-out when the meta file is missing or unparseable.
 *
 * Templates may declare an initialMessages array in their template.json. When
 * a project is created from such a template, those messages are persisted to
 * the project's metadata and surfaced on both POST /projects (create) and
 * GET /projects/:id (retrieve) responses. initialMessages is detail-only — it
 * is NOT included in GET /projects (list). Blank projects and templates
 * without initialMessages omit the field entirely (not an empty array).
 *
 * POST /projects accepts an optional `orgAlias` that names a Salesforce org
 * already authenticated via the SFDX CLI. When provided:
 *   - The alias is validated against the local auth store (StateAggregator).
 *     A non-empty alias that does not resolve to a username → 400.
 *     An empty string → 400.
 *   - On success, the alias is persisted to `.sf/config.json` as `target-org`
 *     in the project directory. `POST /v1/projects/:id/deployments` reads
 *     this value to resolve auth server-side (see spec/deploy/contract.spec.ts
 *     for the deploy-time resolution chain).
 *   - The create response includes `targetOrg: "<alias>"`. When omitted,
 *     `targetOrg` is absent from the response.
 *
 * They are the source of truth for these endpoints' external behavior. The
 * AI implementation agent must NOT modify this file.
 *
 * Mock boundary: @salesforce/core — specifically `StateAggregator.getInstance`
 * — is mocked so tests can control alias → username resolution without a real
 * keychain. Real: filesystem, Fastify, template unzipping.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const { mockGetUsername } = vi.hoisted(() => ({
  mockGetUsername: vi.fn(),
}));

// By default aliases resolve to nothing. Individual tests override this mock
// to register specific alias → username mappings.
vi.mock('@salesforce/core', () => ({
  StateAggregator: {
    clearInstance: vi.fn(),
    getInstance: vi.fn().mockResolvedValue({
      aliases: { getUsername: mockGetUsername },
    }),
  },
  ConfigAggregator: {
    create: vi.fn().mockResolvedValue({
      getPropertyValue: vi.fn().mockReturnValue(undefined),
    }),
  },
  OrgConfigProperties: { TARGET_ORG: 'target-org' },
  Global: { SFDX_STATE_FOLDER: '.sfdx' },
}));

import { createApp } from '../../src/app.js';

const TEST_ORG_ALIAS = 'my-scratch-org';
const TEST_USERNAME = 'test-user@example.com';

describe('Projects API', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-projects-test-'));
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

  describe('POST /projects', () => {
    it('returns 201 with id, name, and lastAccessedAt when given a valid template', async () => {
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'local-react-test' })
        .expect(201);

      expect(res.body).toHaveProperty('id');
      expect(typeof res.body.id).toBe('string');
      expect(res.body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(res.body).toHaveProperty('name');
      expect(typeof res.body.name).toBe('string');
      expect(res.body.name.length).toBeGreaterThan(0);
      expect(res.body).toHaveProperty('lastAccessedAt');
      expect(typeof res.body.lastAccessedAt).toBe('string');
      expect(new Date(res.body.lastAccessedAt).toISOString()).toBe(res.body.lastAccessedAt);
    });

    it('returns 400 when template is unknown', async () => {
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'nonexistent-template' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 201 with id, name, and lastAccessedAt when no template is provided', async () => {
      const res = await request(app.server).post('/v1/projects').send({}).expect(201);

      expect(res.body).toHaveProperty('id');
      expect(typeof res.body.id).toBe('string');
      expect(res.body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(res.body).toHaveProperty('name');
      expect(typeof res.body.name).toBe('string');
      expect(res.body.name.length).toBeGreaterThan(0);
      expect(res.body).toHaveProperty('lastAccessedAt');
      expect(typeof res.body.lastAccessedAt).toBe('string');
      expect(new Date(res.body.lastAccessedAt).toISOString()).toBe(res.body.lastAccessedAt);
    });

    it('created project lastAccessedAt matches the value in GET /projects', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const listRes = await request(app.server).get('/v1/projects').expect(200);
      const listed = listRes.body.find((p: { id: string }) => p.id === createRes.body.id);

      expect(listed).toBeDefined();
      expect(listed.lastAccessedAt).toBe(createRes.body.lastAccessedAt);
    });

    it('blank project contains sfdx-project.json', async () => {
      const res = await request(app.server).post('/v1/projects').send({}).expect(201);

      const projectDir = path.join(tmpDir, res.body.id);
      const stat = await fs.stat(projectDir);
      expect(stat.isDirectory()).toBe(true);

      const configPath = path.join(projectDir, 'sfdx-project.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      expect(config.packageDirectories).toBeInstanceOf(Array);
      expect(config.packageDirectories.length).toBeGreaterThan(0);

      // Blank scaffold includes the default package directory
      const defaultDir = path.join(projectDir, 'force-app', 'main', 'default');
      const dirStat = await fs.stat(defaultDir);
      expect(dirStat.isDirectory()).toBe(true);
    });

    it('creates a project directory with sfdx-project.json', async () => {
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'local-react-test' })
        .expect(201);

      const projectDir = path.join(tmpDir, res.body.id);
      const stat = await fs.stat(projectDir);
      expect(stat.isDirectory()).toBe(true);

      const configPath = path.join(projectDir, 'sfdx-project.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      expect(config.packageDirectories).toBeInstanceOf(Array);
      expect(config.packageDirectories.length).toBeGreaterThan(0);
    });

    it('returns initialMessages when the template defines them', async () => {
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'local-react-test' })
        .expect(201);

      expect(Array.isArray(res.body.initialMessages)).toBe(true);
      expect(res.body.initialMessages.length).toBeGreaterThan(0);
      for (const msg of res.body.initialMessages) {
        expect(typeof msg.role).toBe('string');
        expect(msg.role.length).toBeGreaterThan(0);
        expect(typeof msg.content).toBe('string');
        expect(msg.content.length).toBeGreaterThan(0);
      }
    });

    it('omits initialMessages when creating a blank project (no template)', async () => {
      const res = await request(app.server).post('/v1/projects').send({}).expect(201);

      expect(res.body.initialMessages).toBeUndefined();
    });

    it('initialMessages in the create response matches the value returned by GET /projects/:id', async () => {
      const createRes = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'local-react-test' })
        .expect(201);

      const getRes = await request(app.server).get(`/v1/projects/${createRes.body.id}`).expect(200);

      expect(getRes.body.initialMessages).toEqual(createRes.body.initialMessages);
    });

    describe('orgAlias', () => {
      beforeEach(() => {
        // Default for this describe: the canonical test alias resolves to a
        // known username; any other alias is unknown.
        mockGetUsername.mockImplementation((alias: string) =>
          alias === TEST_ORG_ALIAS ? TEST_USERNAME : undefined
        );
      });

      afterEach(() => {
        mockGetUsername.mockReset();
      });

      it('returns 201 with targetOrg when orgAlias is provided', async () => {
        const res = await request(app.server)
          .post('/v1/projects')
          .send({ orgAlias: TEST_ORG_ALIAS })
          .expect(201);

        expect(res.body).toHaveProperty('id');
        expect(res.body).toHaveProperty('name');
        expect(res.body).toHaveProperty('targetOrg', TEST_ORG_ALIAS);
      });

      it('persists target-org in .sf/config.json', async () => {
        const res = await request(app.server)
          .post('/v1/projects')
          .send({ orgAlias: TEST_ORG_ALIAS })
          .expect(201);

        const configPath = path.join(tmpDir, res.body.id, '.sf', 'config.json');
        const raw = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(raw) as Record<string, string>;
        expect(config['target-org']).toBe(TEST_ORG_ALIAS);
      });

      it('omits targetOrg from the response when orgAlias is not provided', async () => {
        const res = await request(app.server).post('/v1/projects').send({}).expect(201);

        expect(res.body.targetOrg).toBeUndefined();
      });

      it('returns 400 Problem Detail when orgAlias is an empty string', async () => {
        const res = await request(app.server)
          .post('/v1/projects')
          .send({ orgAlias: '' })
          .expect(400);

        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body.status).toBe(400);
      });

      it('returns 400 Problem Detail when orgAlias does not resolve in the auth store', async () => {
        const res = await request(app.server)
          .post('/v1/projects')
          .send({ orgAlias: 'unknown-alias' })
          .expect(400);

        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body.status).toBe(400);
        // Error detail must name the offending alias so callers can act.
        expect(res.body.detail).toContain('unknown-alias');
      });
    });

    describe('blank-project naming (Untitled N)', () => {
      // Each test creates blank projects in an isolated PROJECTS_ROOT so the
      // count-based numbering is deterministic and not polluted by other tests.
      let isolatedDir: string;
      let isolatedApp: ReturnType<typeof createApp>;
      let originalRoot: string | undefined;

      beforeEach(async () => {
        isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'untitled-naming-'));
        originalRoot = process.env.PROJECTS_ROOT;
        process.env.PROJECTS_ROOT = isolatedDir;
        isolatedApp = createApp();
        await isolatedApp.ready();
      });

      afterEach(async () => {
        await isolatedApp.close();
        process.env.PROJECTS_ROOT = originalRoot;
        await fs.rm(isolatedDir, { recursive: true, force: true });
      });

      it('names the first blank project "Untitled"', async () => {
        const res = await request(isolatedApp.server).post('/v1/projects').send({}).expect(201);
        expect(res.body.name).toBe('Untitled');
      });

      it('numbers subsequent blank projects: Untitled, Untitled 2, Untitled 3', async () => {
        const r1 = await request(isolatedApp.server).post('/v1/projects').send({}).expect(201);
        const r2 = await request(isolatedApp.server).post('/v1/projects').send({}).expect(201);
        const r3 = await request(isolatedApp.server).post('/v1/projects').send({}).expect(201);
        expect(r1.body.name).toBe('Untitled');
        expect(r2.body.name).toBe('Untitled 2');
        expect(r3.body.name).toBe('Untitled 3');
      });

      it('does not reuse a freed gap when the highest N also moved', async () => {
        // After {Untitled} the only highest-N is N=1, so the next blank is
        // Untitled 2 — same outcome as a fresh second create. Renaming the
        // second project away from "Untitled 2" leaves only "Untitled", so
        // maxN = 1, next = "Untitled 2".
        const r1 = await request(isolatedApp.server).post('/v1/projects').send({}).expect(201);
        const r2 = await request(isolatedApp.server).post('/v1/projects').send({}).expect(201);
        await request(isolatedApp.server)
          .patch(`/v1/projects/${r2.body.id}`)
          .send({ name: 'Custom Name' })
          .expect(200);
        const r3 = await request(isolatedApp.server).post('/v1/projects').send({}).expect(201);
        expect(r1.body.name).toBe('Untitled');
        expect(r3.body.name).toBe('Untitled 2');
      });

      it('never reuses an in-use number when a middle slot was renamed away', async () => {
        // Regression test: under "count of matches + 1" naming, this scenario
        // produced a collision. After {Untitled, Untitled 3} (because Untitled
        // 2 was renamed), count=2 + 1 = 3 → "Untitled 3" already exists.
        // The max-based scheme returns "Untitled 4" instead.
        const r1 = await request(isolatedApp.server).post('/v1/projects').send({}).expect(201);
        const r2 = await request(isolatedApp.server).post('/v1/projects').send({}).expect(201);
        await request(isolatedApp.server).post('/v1/projects').send({}).expect(201);
        await request(isolatedApp.server)
          .patch(`/v1/projects/${r2.body.id}`)
          .send({ name: 'My App' })
          .expect(200);

        const r4 = await request(isolatedApp.server).post('/v1/projects').send({}).expect(201);

        expect(r1.body.name).toBe('Untitled');
        // Highest existing N is 3 (Untitled 3 still exists), so next is 4 — not 3.
        expect(r4.body.name).toBe('Untitled 4');
        // And critically: the new name does not collide with any existing project.
        const all = await request(isolatedApp.server).get('/v1/projects').expect(200);
        const names: string[] = all.body.map((p: { name: string }) => p.name);
        expect(new Set(names).size).toBe(names.length);
      });
    });

    describe('template-flow naming (TemplateName N)', () => {
      let isolatedDir: string;
      let isolatedApp: ReturnType<typeof createApp>;
      let originalRoot: string | undefined;

      beforeEach(async () => {
        isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'template-naming-'));
        originalRoot = process.env.PROJECTS_ROOT;
        process.env.PROJECTS_ROOT = isolatedDir;
        isolatedApp = createApp();
        await isolatedApp.ready();
      });

      afterEach(async () => {
        await isolatedApp.close();
        process.env.PROJECTS_ROOT = originalRoot;
        await fs.rm(isolatedDir, { recursive: true, force: true });
      });

      // Template extraction copies a real React/Vite scaffold, which is heavy
      // and can exceed the default 5s budget under shared-runner load.
      it('uses the template display name (from template.json:name) for the first instance', async () => {
        const res = await request(isolatedApp.server)
          .post('/v1/projects')
          .send({ template: 'data-curator' })
          .expect(201);
        // template.json declares { "name": "Data Curator" }
        expect(res.body.name).toBe('Data Curator');
      }, 30_000);

      it('numbers subsequent template projects: TemplateName, TemplateName 2, TemplateName 3', async () => {
        const r1 = await request(isolatedApp.server)
          .post('/v1/projects')
          .send({ template: 'data-curator' })
          .expect(201);
        const r2 = await request(isolatedApp.server)
          .post('/v1/projects')
          .send({ template: 'data-curator' })
          .expect(201);
        const r3 = await request(isolatedApp.server)
          .post('/v1/projects')
          .send({ template: 'data-curator' })
          .expect(201);
        expect(r1.body.name).toBe('Data Curator');
        expect(r2.body.name).toBe('Data Curator 2');
        expect(r3.body.name).toBe('Data Curator 3');
      }, // Template extraction copies a real React/Vite scaffold, which is heavy. // Three sequential extractions can exceed the default 5s budget.
      30000);

      it('names persist across project list and retrieve', async () => {
        const createRes = await request(isolatedApp.server)
          .post('/v1/projects')
          .send({ template: 'data-curator' })
          .expect(201);
        const createdName = createRes.body.name;

        const listRes = await request(isolatedApp.server).get('/v1/projects').expect(200);
        const listedProject = listRes.body.find((p: { id: string }) => p.id === createRes.body.id);
        expect(listedProject.name).toBe(createdName);

        const getRes = await request(isolatedApp.server)
          .get(`/v1/projects/${createRes.body.id}`)
          .expect(200);
        expect(getRes.body.name).toBe(createdName);
      }, 30_000);
    });
  });

  describe('GET /projects', () => {
    it('returns 200 with an array of projects', async () => {
      // Create two projects
      const res1 = await request(app.server).post('/v1/projects').send({}).expect(201);
      const res2 = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'local-react-test' })
        .expect(201);

      const res = await request(app.server).get('/v1/projects').expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      const ids = res.body.map((p: { id: string }) => p.id);
      expect(ids).toContain(res1.body.id);
      expect(ids).toContain(res2.body.id);
    });

    it('each project has id, name, and lastAccessedAt', async () => {
      await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server).get('/v1/projects').expect(200);

      for (const project of res.body) {
        expect(project).toHaveProperty('id');
        expect(typeof project.id).toBe('string');
        expect(project).toHaveProperty('name');
        expect(typeof project.name).toBe('string');
        expect(project.name.length).toBeGreaterThan(0);
        expect(project).toHaveProperty('lastAccessedAt');
        expect(typeof project.lastAccessedAt).toBe('string');
        expect(new Date(project.lastAccessedAt).toISOString()).toBe(project.lastAccessedAt);
      }
    });

    it('accessing a project updates its lastAccessedAt', async () => {
      // Use an isolated directory so we control the full list
      const accessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-projects-access-'));
      const originalRoot = process.env.PROJECTS_ROOT;
      process.env.PROJECTS_ROOT = accessDir;

      try {
        const accessApp = createApp();
        await accessApp.ready();

        // Create a project
        const createRes = await request(accessApp.server).post('/v1/projects').send({}).expect(201);

        // Capture initial lastAccessedAt
        const list1 = await request(accessApp.server).get('/v1/projects').expect(200);
        const initial = list1.body.find((p: { id: string }) => p.id === createRes.body.id);
        const initialTimestamp = initial.lastAccessedAt;

        // Small delay to ensure timestamp difference is observable
        await new Promise((r) => setTimeout(r, 50));

        // Access the project (GET tree triggers lastAccessedAt update)
        await request(accessApp.server).get(`/v1/projects/${createRes.body.id}/tree`).expect(200);

        // Capture updated lastAccessedAt
        const list2 = await request(accessApp.server).get('/v1/projects').expect(200);
        const updated = list2.body.find((p: { id: string }) => p.id === createRes.body.id);

        // lastAccessedAt must have advanced
        expect(updated.lastAccessedAt > initialTimestamp).toBe(true);

        await accessApp.close();
      } finally {
        process.env.PROJECTS_ROOT = originalRoot;
        await fs.rm(accessDir, { recursive: true, force: true });
      }
    });

    it('freshly created project has lastAccessedAt set to creation time', async () => {
      const accessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-projects-initial-'));
      const originalRoot = process.env.PROJECTS_ROOT;
      process.env.PROJECTS_ROOT = accessDir;

      try {
        const freshApp = createApp();
        await freshApp.ready();

        const before = new Date().toISOString();
        await request(freshApp.server).post('/v1/projects').send({}).expect(201);
        const after = new Date().toISOString();

        const res = await request(freshApp.server).get('/v1/projects').expect(200);
        const project = res.body[0];

        expect(project.lastAccessedAt >= before).toBe(true);
        expect(project.lastAccessedAt <= after).toBe(true);

        await freshApp.close();
      } finally {
        process.env.PROJECTS_ROOT = originalRoot;
        await fs.rm(accessDir, { recursive: true, force: true });
      }
    });

    it('returns empty array when no projects exist', async () => {
      // Use an isolated empty directory
      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-projects-empty-'));
      const originalRoot = process.env.PROJECTS_ROOT;
      process.env.PROJECTS_ROOT = emptyDir;

      try {
        const freshApp = createApp();
        await freshApp.ready();
        const res = await request(freshApp.server).get('/v1/projects').expect(200);
        await freshApp.close();

        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toHaveLength(0);
      } finally {
        process.env.PROJECTS_ROOT = originalRoot;
        await fs.rm(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('GET /projects/:id', () => {
    it('returns 200 with id, name, and lastAccessedAt for an existing project', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server).get(`/v1/projects/${createRes.body.id}`).expect(200);

      expect(res.body).toHaveProperty('id', createRes.body.id);
      expect(res.body).toHaveProperty('name');
      expect(typeof res.body.name).toBe('string');
      expect(res.body.name.length).toBeGreaterThan(0);
      expect(res.body.name).toBe(createRes.body.name);
      expect(res.body).toHaveProperty('lastAccessedAt');
      expect(typeof res.body.lastAccessedAt).toBe('string');
      expect(new Date(res.body.lastAccessedAt).toISOString()).toBe(res.body.lastAccessedAt);
    });

    it('bumps lastAccessedAt past the creation time', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      // Small delay so the access timestamp is observably later than creation.
      await new Promise((r) => setTimeout(r, 10));

      const res = await request(app.server).get(`/v1/projects/${createRes.body.id}`).expect(200);

      expect(res.body.lastAccessedAt > createRes.body.lastAccessedAt).toBe(true);
    });

    it('returned lastAccessedAt matches the value in GET /projects', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const getRes = await request(app.server).get(`/v1/projects/${createRes.body.id}`).expect(200);

      const listRes = await request(app.server).get('/v1/projects').expect(200);
      const listed = listRes.body.find((p: { id: string }) => p.id === createRes.body.id);

      expect(listed).toBeDefined();
      expect(listed.lastAccessedAt).toBe(getRes.body.lastAccessedAt);
    });

    it('returns the renamed name and bumps lastAccessedAt past the PATCH time', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const patchRes = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: 'my-custom-name' })
        .expect(200);

      // Small delay so the GET timestamp is observably later than the PATCH.
      await new Promise((r) => setTimeout(r, 10));

      const res = await request(app.server).get(`/v1/projects/${createRes.body.id}`).expect(200);

      expect(res.body).toHaveProperty('name', 'my-custom-name');
      expect(res.body.lastAccessedAt > patchRes.body.lastAccessedAt).toBe(true);
    });

    it('every GET bumps lastAccessedAt (not just the first access)', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const firstGet = await request(app.server)
        .get(`/v1/projects/${createRes.body.id}`)
        .expect(200);

      // Small delay so the second bump is observably later than the first.
      await new Promise((r) => setTimeout(r, 10));

      const secondGet = await request(app.server)
        .get(`/v1/projects/${createRes.body.id}`)
        .expect(200);

      expect(secondGet.body.lastAccessedAt > firstGet.body.lastAccessedAt).toBe(true);
    });

    it('returns 404 Problem Detail for a valid UUID that does not exist', async () => {
      const missingId = randomUUID();

      const res = await request(app.server).get(`/v1/projects/${missingId}`).expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
      expect(res.body).toHaveProperty('title');
    });

    it('returns 404 Problem Detail when the id is not a UUID', async () => {
      const res = await request(app.server).get('/v1/projects/not-a-uuid').expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
      expect(res.body).toHaveProperty('title');
    });

    it('returns initialMessages for a project created from a template that defines them', async () => {
      const createRes = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'local-react-test' })
        .expect(201);

      const res = await request(app.server).get(`/v1/projects/${createRes.body.id}`).expect(200);

      expect(Array.isArray(res.body.initialMessages)).toBe(true);
      expect(res.body.initialMessages.length).toBeGreaterThan(0);
      for (const msg of res.body.initialMessages) {
        expect(typeof msg.role).toBe('string');
        expect(msg.role.length).toBeGreaterThan(0);
        expect(typeof msg.content).toBe('string');
        expect(msg.content.length).toBeGreaterThan(0);
      }
    });

    it('omits initialMessages for a blank project', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server).get(`/v1/projects/${createRes.body.id}`).expect(200);

      expect(res.body.initialMessages).toBeUndefined();
    });

    it('preserves initialMessages across PATCH rename', async () => {
      const createRes = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'local-react-test' })
        .expect(201);
      const seeded = createRes.body.initialMessages;
      expect(Array.isArray(seeded) && seeded.length > 0).toBe(true);

      await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: 'renamed-with-seed' })
        .expect(200);

      const res = await request(app.server).get(`/v1/projects/${createRes.body.id}`).expect(200);

      expect(res.body.initialMessages).toEqual(seeded);
    });
  });

  describe('PATCH /projects/:id', () => {
    it('returns 200 with updated name and lastAccessedAt', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      // Small delay so the rename timestamp differs from create timestamp
      await new Promise((r) => setTimeout(r, 10));

      const res = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: 'my-custom-name' })
        .expect(200);

      expect(res.body).toHaveProperty('id', createRes.body.id);
      expect(res.body).toHaveProperty('name', 'my-custom-name');
      expect(res.body).toHaveProperty('lastAccessedAt');
      expect(typeof res.body.lastAccessedAt).toBe('string');
      expect(new Date(res.body.lastAccessedAt).toISOString()).toBe(res.body.lastAccessedAt);
      expect(res.body.lastAccessedAt > createRes.body.lastAccessedAt).toBe(true);
    });

    it('persists the renamed value', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: 'renamed-project' })
        .expect(200);

      const listRes = await request(app.server).get('/v1/projects').expect(200);
      const project = listRes.body.find((p: { id: string }) => p.id === createRes.body.id);
      expect(project).toBeDefined();
      expect(project.name).toBe('renamed-project');
    });

    it('rename response lastAccessedAt matches the value in GET /projects', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const patchRes = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: 'renamed-sync' })
        .expect(200);

      const listRes = await request(app.server).get('/v1/projects').expect(200);
      const listed = listRes.body.find((p: { id: string }) => p.id === createRes.body.id);
      expect(listed).toBeDefined();
      expect(listed.lastAccessedAt).toBe(patchRes.body.lastAccessedAt);
    });

    it('returns 404 for nonexistent project', async () => {
      const res = await request(app.server)
        .patch('/v1/projects/00000000-0000-0000-0000-000000000000')
        .send({ name: 'anything' })
        .expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
    });

    it('returns 400 when name is missing', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({})
        .expect(400);

      expect(res.body.status).toBe(400);
    });

    it('returns 400 when name is empty string', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: '' })
        .expect(400);

      expect(res.body.status).toBe(400);
    });

    it('returns 400 when name is only whitespace (trimmed to empty)', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: '   \n\t   ' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 when name exceeds 80 characters', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const longName = 'a'.repeat(81);
      const res = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: longName })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 200 when name is exactly 80 characters', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const eightyCharName = 'a'.repeat(80);
      const res = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: eightyCharName })
        .expect(200);

      expect(res.body.name).toBe(eightyCharName);
    });

    it('trims leading and trailing whitespace from name', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: '  my-project-name  ' })
        .expect(200);

      expect(res.body.name).toBe('my-project-name');
    });

    it('persists trimmed name to metadata', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: '  trimmed-name  ' })
        .expect(200);

      const listRes = await request(app.server).get('/v1/projects').expect(200);
      const project = listRes.body.find((p: { id: string }) => p.id === createRes.body.id);
      expect(project.name).toBe('trimmed-name');
    });

    it('returns InvalidProjectNameError (400 Problem Detail) for invalid names', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: '' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.title).toMatch(/invalid|bad|name/i);
    });
  });

  describe('GET /projects/:id/tree', () => {
    it('returns 200 with tree structure for an existing project', async () => {
      const createRes = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'local-react-test' })
        .expect(201);

      const res = await request(app.server)
        .get(`/v1/projects/${createRes.body.id}/tree`)
        .expect(200);

      expect(res.body).toHaveProperty('name');
      expect(res.body).toHaveProperty('type', 'directory');
      expect(res.body).toHaveProperty('children');
      expect(Array.isArray(res.body.children)).toBe(true);
    });

    it('returns 200 with tree structure for a blank project', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server)
        .get(`/v1/projects/${createRes.body.id}/tree`)
        .expect(200);

      expect(res.body).toHaveProperty('name');
      expect(res.body).toHaveProperty('type', 'directory');
      expect(res.body).toHaveProperty('children');
      expect(Array.isArray(res.body.children)).toBe(true);
    });

    it('returns 404 for a nonexistent project', async () => {
      const res = await request(app.server)
        .get('/v1/projects/00000000-0000-0000-0000-000000000000/tree')
        .expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
    });
  });

  describe('meta file integrity', () => {
    // Context: issue #200 / W-22261249. An access route that bumps
    // lastAccessedAt must never fabricate or overwrite .project-meta.json
    // when the file is missing or unparseable at access time. Writing a
    // synthesized { name: <uuid> } back to disk is how the original bug
    // silently corrupted projects.
    //
    // Narrowed contract: "every access bumps lastAccessedAt" applies only
    // to projects with a valid meta file. Missing or unparseable meta
    // skips the bump to preserve recoverability — a later explicit write
    // (e.g. PATCH rename) can restore the project's name.

    it('does not overwrite .project-meta.json when it is missing at access time', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);
      const metaPath = path.join(tmpDir, createRes.body.id, '.project-meta.json');

      await fs.unlink(metaPath);

      await request(app.server).get(`/v1/projects/${createRes.body.id}`).expect(200);

      // Either the file stays absent, or (if something legitimately
      // recreated it) its `name` must NOT be the UUID — fabricating
      // UUID-as-name is the bug this contract rules out.
      let exists = true;
      try {
        await fs.access(metaPath);
      } catch {
        exists = false;
      }
      if (exists) {
        const parsed = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as { name?: string };
        expect(parsed.name).not.toBe(createRes.body.id);
      }
    });

    it('does not overwrite .project-meta.json when it is unparseable', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);
      const metaPath = path.join(tmpDir, createRes.body.id, '.project-meta.json');

      const corrupted = '{invalid-json-sentinel';
      await fs.writeFile(metaPath, corrupted);

      await request(app.server).get(`/v1/projects/${createRes.body.id}`).expect(200);

      const after = await fs.readFile(metaPath, 'utf-8');
      expect(after).toBe(corrupted);
    });

    it('tree access also leaves a corrupted .project-meta.json unchanged', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);
      const metaPath = path.join(tmpDir, createRes.body.id, '.project-meta.json');

      const corrupted = '{corrupt-through-tree-route';
      await fs.writeFile(metaPath, corrupted);

      await request(app.server).get(`/v1/projects/${createRes.body.id}/tree`).expect(200);

      const after = await fs.readFile(metaPath, 'utf-8');
      expect(after).toBe(corrupted);
    });

    it('file read also leaves a corrupted .project-meta.json unchanged', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);
      const metaPath = path.join(tmpDir, createRes.body.id, '.project-meta.json');

      const corrupted = '{corrupt-through-file-route';
      await fs.writeFile(metaPath, corrupted);

      await request(app.server)
        .get(`/v1/projects/${createRes.body.id}/file`)
        .query({ path: 'sfdx-project.json' })
        .expect(200);

      const after = await fs.readFile(metaPath, 'utf-8');
      expect(after).toBe(corrupted);
    });

    it('PATCH rename recovers a project whose .project-meta.json is corrupted', async () => {
      // This test enforces the recovery promise made in contract.md:
      // a human can always heal a corrupted project via PATCH rename. Without
      // this assertion, an implementation could throw on any unreadable meta
      // (including inside renameProject) and silently break the recovery story
      // that justifies the narrowed lastAccessedAt invariant above.
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);
      const metaPath = path.join(tmpDir, createRes.body.id, '.project-meta.json');

      await fs.writeFile(metaPath, '{not-valid-json');

      const patchRes = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: 'recovered-name' })
        .expect(200);

      expect(patchRes.body.name).toBe('recovered-name');

      // Post-rename meta must be valid JSON with the new name — not the UUID.
      const parsed = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as { name?: string };
      expect(parsed.name).toBe('recovered-name');
      expect(parsed.name).not.toBe(createRes.body.id);
    });
  });
});
