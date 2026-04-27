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
 *   - POST /projects        — create a project (returns id + name + lastAccessedAt)
 *   - GET /projects          — list all projects (id + name + lastAccessedAt)
 *   - GET /projects/:id      — retrieve a project by ID (id + name + lastAccessedAt)
 *   - PATCH /projects/:id    — rename a project (returns id + name + lastAccessedAt)
 *   - GET /projects/:id/tree — file tree for a project
 *
 * Every response that references a project includes lastAccessedAt. Create and
 * rename operations bump it; accessing a project by :id (GET, PATCH, tree, file)
 * also updates it. A freshly created project's lastAccessedAt equals its
 * creation time. They are the source of truth for these endpoints' external
 * behavior. The AI implementation agent must NOT modify this file.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';

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

    it('returns the renamed name after PATCH', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: 'my-custom-name' })
        .expect(200);

      const res = await request(app.server).get(`/v1/projects/${createRes.body.id}`).expect(200);

      expect(res.body).toHaveProperty('name', 'my-custom-name');
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
});
