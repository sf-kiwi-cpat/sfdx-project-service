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
 *   - POST /projects        — create a project (returns id + generated name)
 *   - GET /projects          — list all projects (id + name)
 *   - PATCH /projects/:id    — rename a project
 *   - GET /projects/:id/tree — file tree for a project
 *
 * They are the source of truth for these endpoints' external behavior.
 * The AI implementation agent must NOT modify this file.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
    it('returns 201 with id, name, and createdAt when given a valid template', async () => {
      const before = new Date().toISOString();
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
      expect(res.body).toHaveProperty('createdAt');
      expect(typeof res.body.createdAt).toBe('string');
      expect(new Date(res.body.createdAt).toISOString()).toBe(res.body.createdAt);
      expect(res.body.createdAt >= before).toBe(true);
    });

    it('returns 400 when template is unknown', async () => {
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'nonexistent-template' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 201 with id, name, and createdAt when no template is provided', async () => {
      const before = new Date().toISOString();
      const res = await request(app.server).post('/v1/projects').send({}).expect(201);

      expect(res.body).toHaveProperty('id');
      expect(typeof res.body.id).toBe('string');
      expect(res.body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(res.body).toHaveProperty('name');
      expect(typeof res.body.name).toBe('string');
      expect(res.body.name.length).toBeGreaterThan(0);
      expect(res.body).toHaveProperty('createdAt');
      expect(typeof res.body.createdAt).toBe('string');
      expect(new Date(res.body.createdAt).toISOString()).toBe(res.body.createdAt);
      expect(res.body.createdAt >= before).toBe(true);
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

    it('each project has id, name, and createdAt', async () => {
      await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server).get('/v1/projects').expect(200);

      for (const project of res.body) {
        expect(project).toHaveProperty('id');
        expect(typeof project.id).toBe('string');
        expect(project).toHaveProperty('name');
        expect(typeof project.name).toBe('string');
        expect(project.name.length).toBeGreaterThan(0);
        expect(project).toHaveProperty('createdAt');
        expect(typeof project.createdAt).toBe('string');
      }
    });

    it('each project createdAt is a valid ISO 8601 timestamp', async () => {
      await request(app.server).post('/v1/projects').send({}).expect(201);
      await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server).get('/v1/projects').expect(200);

      for (const project of res.body) {
        expect(new Date(project.createdAt).toISOString()).toBe(project.createdAt);
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

  describe('PATCH /projects/:id', () => {
    it('returns 200 with updated name', async () => {
      const createRes = await request(app.server).post('/v1/projects').send({}).expect(201);

      const res = await request(app.server)
        .patch(`/v1/projects/${createRes.body.id}`)
        .send({ name: 'my-custom-name' })
        .expect(200);

      expect(res.body).toHaveProperty('id', createRes.body.id);
      expect(res.body).toHaveProperty('name', 'my-custom-name');
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
