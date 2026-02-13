import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from './app.js';

vi.mock('@salesforce/core', () => ({
  AuthInfo: {
    create: vi.fn().mockResolvedValue({
      save: vi.fn().mockResolvedValue(undefined),
      setAsDefault: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

describe('SF Project Service API', () => {
  let tmpDir: string;
  let originalProjectRoot: string | undefined;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-project-'));
    originalProjectRoot = process.env.PROJECT_ROOT;
    process.env.PROJECT_ROOT = tmpDir;
    app = createApp();
  });

  afterEach(async () => {
    process.env.PROJECT_ROOT = originalProjectRoot;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('POST /project/init', () => {
    it('scaffolds project and connects org', async () => {
      const res = await request(app)
        .post('/project/init')
        .send({ accessToken: 'test-token', instanceUrl: 'https://test.salesforce.com' })
        .expect(201);

      expect(res.body.ok).toBe(true);
      expect(res.body.message).toContain('Project scaffolded');

      const projectJson = await fs.readFile(path.join(tmpDir, 'sfdx-project.json'), 'utf-8');
      const config = JSON.parse(projectJson);
      expect(config.packageDirectories).toBeDefined();
      expect(config.sourceApiVersion).toBeDefined();
    });

    it('returns 400 when accessToken is missing', async () => {
      const res = await request(app)
        .post('/project/init')
        .send({ instanceUrl: 'https://test.salesforce.com' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
      expect(res.body.title).toBe('Bad Request');
    });

    it('returns 400 when instanceUrl is missing', async () => {
      const res = await request(app)
        .post('/project/init')
        .send({ accessToken: 'test-token' })
        .expect(400);

      expect(res.body.status).toBe(400);
    });

    it('returns 400 when instanceUrl is not a valid URL', async () => {
      const res = await request(app)
        .post('/project/init')
        .send({ accessToken: 'test-token', instanceUrl: 'not-a-url' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
      expect(res.body.detail).toContain('valid URL');
    });

    it('returns 409 when lock is held', async () => {
      await request(app).post('/internal/lock').expect(200);

      const res = await request(app)
        .post('/project/init')
        .send({ accessToken: 'test-token', instanceUrl: 'https://test.salesforce.com' })
        .expect(409);

      expect(res.body).toMatchObject({ status: 409, title: 'Agent Active' });
    });
  });

  describe('GET /project/tree', () => {
    it('excludes .git, .sf, node_modules, and dotfiles', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', 'main', 'default'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, '.sf'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'node_modules'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, '.env'), 'secret');

      const res = await request(app).get('/project/tree').expect(200);

      const names = res.body.children?.map((c: { name: string }) => c.name) ?? [];
      expect(names).toContain('force-app');
      expect(names).not.toContain('.git');
      expect(names).not.toContain('.sf');
      expect(names).not.toContain('node_modules');
      expect(names).not.toContain('.env');
    });

    it('returns directory tree', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', 'main', 'default'), { recursive: true });

      const res = await request(app).get('/project/tree').expect(200);

      expect(res.body).toHaveProperty('name');
      expect(res.body).toHaveProperty('type', 'directory');
      expect(res.body).toHaveProperty('children');
    });

    it('returns 404 with RFC 9457 when project directory does not exist', async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });

      const res = await request(app).get('/project/tree').expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 404 });
    });
  });

  describe('GET /project/file', () => {
    beforeEach(async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', 'main', 'default', 'classes'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(tmpDir, 'force-app', 'main', 'default', 'classes', 'Foo.cls'),
        'class Foo {}'
      );
    });

    it('returns file contents', async () => {
      const res = await request(app)
        .get('/project/file')
        .query({ path: 'force-app/main/default/classes/Foo.cls' })
        .expect(200);

      expect(res.text).toBe('class Foo {}');
    });

    it('returns 404 with RFC 9457 problem detail when file does not exist', async () => {
      const res = await request(app)
        .get('/project/file')
        .query({ path: 'force-app/main/default/classes/Nonexistent.cls' })
        .expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 404, title: 'File Not Found' });
      expect(res.body.detail).toContain('No file exists');
    });

    it('returns 400 when path is missing', async () => {
      const res = await request(app).get('/project/file').expect(400);
      expect(res.body.status).toBe(400);
    });

    it('returns 400 for restricted path .sf/auth.json', async () => {
      await fs.mkdir(path.join(tmpDir, '.sf'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, '.sf', 'auth.json'), '{"accessToken":"secret"}');

      const res = await request(app)
        .get('/project/file')
        .query({ path: '.sf/auth.json' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toBe('Access to this path is restricted');
    });

    it('returns 400 for nested restricted path force-app/.git/config', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', '.git'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'force-app', '.git', 'config'), '[core]');

      const res = await request(app)
        .get('/project/file')
        .query({ path: 'force-app/.git/config' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toBe('Access to this path is restricted');
    });
  });

  describe('PUT /project/file', () => {
    it('creates file with content', async () => {
      await request(app)
        .put('/project/file')
        .query({ path: 'force-app/main/default/classes/Foo.cls' })
        .set('Content-Type', 'text/plain')
        .send('class Foo {}')
        .expect(200);

      const content = await fs.readFile(
        path.join(tmpDir, 'force-app', 'main', 'default', 'classes', 'Foo.cls'),
        'utf-8'
      );
      expect(content).toBe('class Foo {}');
    });

    it('creates parent directories', async () => {
      await request(app)
        .put('/project/file')
        .query({ path: 'force-app/main/default/classes/Bar.cls' })
        .set('Content-Type', 'text/plain')
        .send('class Bar {}')
        .expect(200);

      const stat = await fs.stat(path.join(tmpDir, 'force-app', 'main', 'default', 'classes', 'Bar.cls'));
      expect(stat.isFile()).toBe(true);
    });

    it('returns 400 when body is unparsable (wrong content type)', async () => {
      const res = await request(app)
        .put('/project/file')
        .query({ path: 'force-app/main/default/classes/Foo.cls' })
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('content=class Foo {}')
        .expect(400);

      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toContain('Request body');
    });

    it('returns 400 on path traversal', async () => {
      const res = await request(app)
        .put('/project/file')
        .query({ path: '../../../etc/passwd' })
        .set('Content-Type', 'text/plain')
        .send('content')
        .expect(400);

      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toContain('Path escapes project root');
    });

    it('returns 400 for restricted path .sf/auth.json', async () => {
      const res = await request(app)
        .put('/project/file')
        .query({ path: '.sf/auth.json' })
        .set('Content-Type', 'text/plain')
        .send('{"accessToken":"secret"}')
        .expect(400);

      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toBe('Access to this path is restricted');
    });
  });

  describe('DELETE /project/file', () => {
    beforeEach(async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', 'main', 'default', 'classes'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(tmpDir, 'force-app', 'main', 'default', 'classes', 'Foo.cls'),
        'class Foo {}'
      );
    });

    it('deletes file', async () => {
      await request(app)
        .delete('/project/file')
        .query({ path: 'force-app/main/default/classes/Foo.cls' })
        .expect(200);

      await expect(
        fs.access(path.join(tmpDir, 'force-app', 'main', 'default', 'classes', 'Foo.cls'))
      ).rejects.toThrow();
    });

    it('returns 404 when file does not exist', async () => {
      const res = await request(app)
        .delete('/project/file')
        .query({ path: 'force-app/main/default/classes/Nonexistent.cls' })
        .expect(404);

      expect(res.body).toMatchObject({ status: 404, title: 'File Not Found' });
    });

    it('returns 400 when target is a directory', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', 'main', 'default', 'classes'), {
        recursive: true,
      });

      const res = await request(app)
        .delete('/project/file')
        .query({ path: 'force-app/main/default/classes' })
        .expect(400);

      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toContain('Not a file');
    });

    it('returns 400 on path traversal', async () => {
      const res = await request(app)
        .delete('/project/file')
        .query({ path: '../../../etc/passwd' })
        .expect(400);

      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toContain('Path escapes project root');
    });

    it('returns 400 for restricted path .sf/auth.json', async () => {
      await fs.mkdir(path.join(tmpDir, '.sf'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, '.sf', 'auth.json'), '{}');

      const res = await request(app)
        .delete('/project/file')
        .query({ path: '.sf/auth.json' })
        .expect(400);

      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toBe('Access to this path is restricted');
    });
  });

  describe('GET /project/events', () => {
    it('returns SSE stream with correct headers', async () => {
      const server = app.listen(0);
      const port = (server.address() as { port: number }).port;

      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/project/events`, (res) => {
          resolve(res);
          res.destroy();
          server.close();
        });
        req.on('error', reject);
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('emits SSE events when files are written or deleted', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', 'main', 'default'), { recursive: true });

      const server = app.listen(0);
      const port = (server.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      const events: Array<{ type: string; path: string }> = [];
      const client = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get(`${baseUrl}/project/events`, (res) => {
          res.on('data', (chunk: Buffer) => {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  events.push(JSON.parse(line.slice(6)));
                } catch {
                  // ignore parse errors
                }
              }
            }
          });
          resolve(res);
        });
        req.on('error', reject);
      });

      // Give watcher time to attach
      await new Promise((r) => setTimeout(r, 200));

      // Use server for PUT/DELETE so watcher (same process) sees filesystem changes
      await request(app)
        .put('/project/file')
        .query({ path: 'force-app/main/default/Test.cls' })
        .set('Content-Type', 'text/plain')
        .send('class Test {}')
        .expect(200);

      await new Promise((r) => setTimeout(r, 200));

      await request(app)
        .delete('/project/file')
        .query({ path: 'force-app/main/default/Test.cls' })
        .expect(200);

      await new Promise((r) => setTimeout(r, 200));

      (client as http.IncomingMessage).destroy();
      server.close();

      expect(events.some((e) => e.type === 'add' && e.path.includes('Test.cls'))).toBe(true);
      expect(events.some((e) => e.type === 'unlink' && e.path.includes('Test.cls'))).toBe(true);
    });
  });

  describe('Unknown routes', () => {
    it('returns 404 with RFC 9457 JSON for nonexistent path', async () => {
      const res = await request(app).get('/nonexistent').expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 404, title: 'Not Found' });
      expect(res.body.detail).toContain('Cannot GET');
    });
  });

  describe('Internal lock API', () => {
    it('POST /internal/lock acquires lock and returns lockId', async () => {
      const res = await request(app).post('/internal/lock').expect(200);
      expect(res.body).toHaveProperty('lockId');
    });

    it('PATCH /internal/lock renews lock with valid lockId', async () => {
      const acquireRes = await request(app).post('/internal/lock').expect(200);
      const lockId = acquireRes.body.lockId;

      await request(app).patch('/internal/lock').send({ lockId }).expect(200);
    });

    it('DELETE /internal/lock releases lock with valid lockId', async () => {
      const acquireRes = await request(app).post('/internal/lock').expect(200);
      const lockId = acquireRes.body.lockId;

      await request(app).delete('/internal/lock').send({ lockId }).expect(200);
    });

    it('write operations return 409 when lock is held', async () => {
      await request(app).post('/internal/lock').expect(200);

      const res = await request(app)
        .put('/project/file')
        .query({ path: 'force-app/main/default/classes/Foo.cls' })
        .set('Content-Type', 'text/plain')
        .send('class Foo {}')
        .expect(409);

      expect(res.body).toMatchObject({ status: 409, title: 'Agent Active' });
    });
  });
});
