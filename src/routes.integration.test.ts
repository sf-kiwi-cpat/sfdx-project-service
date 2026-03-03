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
  Global: {
    SFDX_STATE_FOLDER: '.sfdx',
  },
  StateAggregator: {
    clearInstance: vi.fn(),
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

      const gitignore = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.sf/');
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
      expect(res.body).toMatchObject({ status: 404, title: 'File Not Found' });
      expect(res.body.detail).not.toMatch(/^\//);
      expect(res.body.detail).not.toContain(tmpDir);
    });

    it('sorts directories before files, alphabetical, case-insensitive', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'Zebra'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'alpha'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'README.md'), '# hi');
      await fs.writeFile(path.join(tmpDir, 'build.xml'), '<xml/>');

      const res = await request(app).get('/project/tree').expect(200);

      const names = res.body.children.map((c: { name: string }) => c.name);
      const dirs = res.body.children
        .filter((c: { type: string }) => c.type === 'directory')
        .map((c: { name: string }) => c.name);
      const files = res.body.children
        .filter((c: { type: string }) => c.type === 'file')
        .map((c: { name: string }) => c.name);

      // All dirs come before all files
      const lastDirIdx = names.lastIndexOf(dirs[dirs.length - 1]);
      const firstFileIdx = names.indexOf(files[0]);
      expect(lastDirIdx).toBeLessThan(firstFileIdx);

      // Dirs are alphabetical case-insensitive
      expect(dirs).toEqual(
        [...dirs].sort((a: string, b: string) =>
          a.localeCompare(b, undefined, { sensitivity: 'base' })
        )
      );
      // Files are alphabetical case-insensitive
      expect(files).toEqual(
        [...files].sort((a: string, b: string) =>
          a.localeCompare(b, undefined, { sensitivity: 'base' })
        )
      );
    });

    it('returns 200 while lock is held', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app'), { recursive: true });
      await request(app).post('/internal/lock').expect(200);

      const res = await request(app).get('/project/tree').expect(200);
      expect(res.body).toHaveProperty('type', 'directory');
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

    it('returns 400 with RFC 9457 for path exceeding MAX_PATH_LENGTH', async () => {
      const res = await request(app)
        .get('/project/file')
        .query({ path: 'a'.repeat(1024) })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toContain('exceeds maximum allowed length');
      expect(res.body.detail).not.toMatch(/^\//);
      expect(res.body.detail).not.toContain(tmpDir);
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

    it('returns 400 on path traversal with ../../../etc/passwd', async () => {
      const res = await request(app)
        .get('/project/file')
        .query({ path: '../../../etc/passwd' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toContain('Path escapes project root');
      expect(res.body.detail).not.toMatch(/^\//);
      expect(res.body.detail).not.toContain(tmpDir);
    });

    it('returns 400 on path traversal with force-app/../../etc/passwd', async () => {
      const res = await request(app)
        .get('/project/file')
        .query({ path: 'force-app/../../etc/passwd' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toContain('Path escapes project root');
      expect(res.body.detail).not.toMatch(/^\//);
      expect(res.body.detail).not.toContain(tmpDir);
    });

    it('returns 400 on absolute path /etc/passwd', async () => {
      const res = await request(app)
        .get('/project/file')
        .query({ path: '/etc/passwd' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 when path points to a directory', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', 'main'), { recursive: true });

      const res = await request(app)
        .get('/project/file')
        .query({ path: 'force-app/main' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toContain('Not a file');
      expect(res.body.detail).not.toMatch(/^\//);
      expect(res.body.detail).not.toContain(tmpDir);
    });

    it('returns 200 while lock is held (reads not blocked)', async () => {
      await request(app).post('/internal/lock').expect(200);

      const res = await request(app)
        .get('/project/file')
        .query({ path: 'force-app/main/default/classes/Foo.cls' })
        .expect(200);

      expect(res.text).toBe('class Foo {}');
    });

    it('returns 400 for restricted path force-app/.hidden/secret.txt', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', '.hidden'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'force-app', '.hidden', 'secret.txt'), 'secret');

      const res = await request(app)
        .get('/project/file')
        .query({ path: 'force-app/.hidden/secret.txt' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toBe('Access to this path is restricted');
    });

    it('returns 400 for restricted path force-app/node_modules/pkg.js', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', 'node_modules'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'force-app', 'node_modules', 'pkg.js'),
        'module.exports = {}'
      );

      const res = await request(app)
        .get('/project/file')
        .query({ path: 'force-app/node_modules/pkg.js' })
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

      const stat = await fs.stat(
        path.join(tmpDir, 'force-app', 'main', 'default', 'classes', 'Bar.cls')
      );
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

    it('returns 400 with RFC 9457 for path exceeding MAX_PATH_LENGTH', async () => {
      const res = await request(app)
        .put('/project/file')
        .query({ path: 'a'.repeat(1024) })
        .set('Content-Type', 'text/plain')
        .send('content')
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toContain('exceeds maximum allowed length');
      expect(res.body.detail).not.toMatch(/^\//);
      expect(res.body.detail).not.toContain(tmpDir);
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

    it('overwrites existing file', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', 'main', 'default', 'classes'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(tmpDir, 'force-app', 'main', 'default', 'classes', 'Foo.cls'),
        'class Foo {}'
      );

      await request(app)
        .put('/project/file')
        .query({ path: 'force-app/main/default/classes/Foo.cls' })
        .set('Content-Type', 'text/plain')
        .send('class Foo { void bar() {} }')
        .expect(200);

      const content = await fs.readFile(
        path.join(tmpDir, 'force-app', 'main', 'default', 'classes', 'Foo.cls'),
        'utf-8'
      );
      expect(content).toBe('class Foo { void bar() {} }');
    });

    it('returns 400 when path param is missing', async () => {
      const res = await request(app)
        .put('/project/file')
        .set('Content-Type', 'text/plain')
        .send('content')
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 for restricted path force-app/.sf/evil.json', async () => {
      const res = await request(app)
        .put('/project/file')
        .query({ path: 'force-app/.sf/evil.json' })
        .set('Content-Type', 'text/plain')
        .send('{}')
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toBe('Access to this path is restricted');
    });

    it('accepts JSON body with content field', async () => {
      await request(app)
        .put('/project/file')
        .query({ path: 'force-app/main/default/classes/Json.cls' })
        .set('Content-Type', 'application/json')
        .send({ content: 'class Json {}' })
        .expect(200);

      const content = await fs.readFile(
        path.join(tmpDir, 'force-app', 'main', 'default', 'classes', 'Json.cls'),
        'utf-8'
      );
      expect(content).toBe('class Json {}');
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

    it('returns 400 with RFC 9457 for path exceeding MAX_PATH_LENGTH', async () => {
      const res = await request(app)
        .delete('/project/file')
        .query({ path: 'a'.repeat(1024) })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toContain('exceeds maximum allowed length');
      expect(res.body.detail).not.toMatch(/^\//);
      expect(res.body.detail).not.toContain(tmpDir);
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

    it('returns 400 when path param is missing', async () => {
      const res = await request(app).delete('/project/file').expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 for restricted path force-app/node_modules/pkg.js', async () => {
      const res = await request(app)
        .delete('/project/file')
        .query({ path: 'force-app/node_modules/pkg.js' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 400, title: 'Bad Request' });
      expect(res.body.detail).toBe('Access to this path is restricted');
    });

    it('returns 409 when lock is held', async () => {
      await request(app).post('/internal/lock').expect(200);

      const res = await request(app)
        .delete('/project/file')
        .query({ path: 'force-app/main/default/classes/Foo.cls' })
        .expect(409);

      expect(res.body).toMatchObject({ status: 409, title: 'Agent Active' });
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

    it('emits change event when file is modified', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', 'main', 'default'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'force-app', 'main', 'default', 'Existing.cls'), 'v1');

      const server = app.listen(0);
      const port = (server.address() as { port: number }).port;

      const events: Array<{ type: string; path: string }> = [];
      const client = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/project/events`, (res) => {
          res.on('data', (chunk: Buffer) => {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  events.push(JSON.parse(line.slice(6)));
                } catch {
                  /* ignore */
                }
              }
            }
          });
          resolve(res);
        });
        req.on('error', reject);
      });

      await new Promise((r) => setTimeout(r, 200));

      // Overwrite existing file to trigger change event
      await request(app)
        .put('/project/file')
        .query({ path: 'force-app/main/default/Existing.cls' })
        .set('Content-Type', 'text/plain')
        .send('v2')
        .expect(200);

      await new Promise((r) => setTimeout(r, 200));

      client.destroy();
      server.close();

      expect(events.some((e) => e.type === 'change' && e.path.includes('Existing.cls'))).toBe(true);
    });

    it('cleans up watcher when client disconnects', async () => {
      const server = app.listen(0);
      const port = (server.address() as { port: number }).port;

      const client = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/project/events`, (res) => {
          resolve(res);
        });
        req.on('error', reject);
      });

      await new Promise((r) => setTimeout(r, 100));

      // Disconnect the client
      client.destroy();

      // Give time for cleanup
      await new Promise((r) => setTimeout(r, 100));

      // If watcher wasn't cleaned up, this would leak. We verify by ensuring
      // the server can still close cleanly (no hanging handles).
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });

  describe('Unknown routes', () => {
    it('returns 404 with RFC 9457 JSON for nonexistent path', async () => {
      const res = await request(app).get('/nonexistent').expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 404, title: 'Not Found' });
      expect(res.body.detail).toContain('Cannot GET');
    });

    it('returns 404 with RFC 9457 JSON for wrong method on valid path', async () => {
      const res = await request(app).post('/project/tree').expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 404, title: 'Not Found' });
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

    it('POST /internal/lock twice returns 409 Lock Held', async () => {
      await request(app).post('/internal/lock').expect(200);

      const res = await request(app).post('/internal/lock').expect(409);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 409, title: 'Lock Held' });
    });

    it('PATCH /internal/lock with wrong lockId returns 404', async () => {
      await request(app).post('/internal/lock').expect(200);

      const res = await request(app)
        .patch('/internal/lock')
        .send({ lockId: 'wrong-id' })
        .expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 404, title: 'Lock Not Found' });
    });

    it('PATCH /internal/lock with missing lockId returns 400', async () => {
      const res = await request(app).patch('/internal/lock').send({}).expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('DELETE /internal/lock with wrong lockId returns 404', async () => {
      await request(app).post('/internal/lock').expect(200);

      const res = await request(app)
        .delete('/internal/lock')
        .send({ lockId: 'wrong-id' })
        .expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 404, title: 'Lock Not Found' });
    });

    it('DELETE /internal/lock with missing lockId returns 400', async () => {
      const res = await request(app).delete('/internal/lock').send({}).expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    describe('TTL expiry', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('lock auto-expires after TTL, allowing writes', async () => {
        await request(app).post('/internal/lock').expect(200);

        // Advance past the 60s TTL
        vi.advanceTimersByTime(61_000);

        const res = await request(app)
          .put('/project/file')
          .query({ path: 'force-app/main/default/classes/Foo.cls' })
          .set('Content-Type', 'text/plain')
          .send('class Foo {}')
          .expect(200);

        expect(res.body).toMatchObject({ ok: true });
      });

      it('renew extends TTL so lock is still held after original expiry', async () => {
        const acquireRes = await request(app).post('/internal/lock').expect(200);
        const lockId = acquireRes.body.lockId;

        // Advance 30s, then renew
        vi.advanceTimersByTime(30_000);
        await request(app).patch('/internal/lock').send({ lockId }).expect(200);

        // Advance another 30s (60s total, but only 30s since renewal)
        vi.advanceTimersByTime(30_000);

        // Lock should still be held — write should be rejected
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
});
