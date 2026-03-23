/**
 * SPEC TESTS — Human-guarded contract (SDLC 2026)
 *
 * These tests define the contract for POST /projects and GET /projects/:id/tree.
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
    it('returns 201 with a project id when given a valid template', async () => {
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'hello-world-1' })
        .expect(201);

      expect(res.body).toHaveProperty('id');
      expect(typeof res.body.id).toBe('string');
      // UUID format
      expect(res.body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('returns 400 when template is unknown', async () => {
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'nonexistent-template' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 when template field is missing', async () => {
      const res = await request(app.server).post('/v1/projects').send({}).expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('creates a project directory with sfdx-project.json', async () => {
      const res = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'hello-world-1' })
        .expect(201);

      const projectDir = path.join(tmpDir, res.body.id);
      const stat = await fs.stat(projectDir);
      expect(stat.isDirectory()).toBe(true);

      const configPath = path.join(projectDir, 'sfdx-project.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      expect(config.packageDirectories).toBeDefined();
    });
  });

  describe('GET /projects/:id/tree', () => {
    it('returns 200 with tree structure for an existing project', async () => {
      // First create a project
      const createRes = await request(app.server)
        .post('/v1/projects')
        .send({ template: 'hello-world-1' })
        .expect(201);

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
