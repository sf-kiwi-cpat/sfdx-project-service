/**
 * SPEC TESTS — Human-guarded contract (SDLC 2026)
 *
 * These tests define the contract for GET /v1/projects/:id/file?path=...
 * They are the source of truth for the file read endpoint's external behavior.
 * The AI implementation agent must NOT modify this file.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../src/app.js';

describe('GET /v1/projects/:id/file', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-file-read-test-'));
    process.env.PROJECTS_ROOT = tmpDir;
  });

  afterAll(async () => {
    delete process.env.PROJECTS_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    app = createApp();
    await app.ready();

    // Create a project to test against
    const res = await request(app.server)
      .post('/v1/projects')
      .send({ template: 'hello-world-1' })
      .expect(201);
    projectId = res.body.id;
  });

  afterEach(async () => {
    await app.close();
  });

  describe('200 — success', () => {
    it('returns file contents as text/plain', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/file`)
        .query({ path: 'sfdx-project.json' })
        .expect(200);

      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('packageDirectories');
    });

    it('reads files in nested directories', async () => {
      // Write a test file in a subdirectory
      const projectDir = path.join(tmpDir, projectId);
      await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(projectDir, 'src', 'hello.txt'), 'hello world');

      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/file`)
        .query({ path: 'src/hello.txt' })
        .expect(200);

      expect(res.text).toBe('hello world');
    });
  });

  describe('400 — bad request', () => {
    it('returns 400 when path query parameter is missing', async () => {
      const res = await request(app.server).get(`/v1/projects/${projectId}/file`).expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 for path traversal attempts', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/file`)
        .query({ path: '../../etc/passwd' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 for restricted paths (.git)', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/file`)
        .query({ path: '.git/config' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 when path points to a directory', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/file`)
        .query({ path: 'force-app' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });
  });

  describe('404 — not found', () => {
    it('returns 404 for a nonexistent project', async () => {
      const res = await request(app.server)
        .get('/v1/projects/00000000-0000-0000-0000-000000000000/file')
        .query({ path: 'sfdx-project.json' })
        .expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
    });

    it('returns 404 for a nonexistent file', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/file`)
        .query({ path: 'does-not-exist.txt' })
        .expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
    });
  });
});
