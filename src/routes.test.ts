import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from './app.js';
import * as oauthModule from './oauth.js';

vi.mock('@salesforce/core', () => ({
  AuthInfo: {
    create: vi.fn().mockResolvedValue({
      save: vi.fn().mockResolvedValue(undefined),
      setAsDefault: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

// Store original fetch for restoration
const originalFetch = global.fetch;

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
      expect(res.body).toMatchObject({ status: 404, title: 'File Not Found' });
      expect(res.body.detail).not.toMatch(/^\//);
      expect(res.body.detail).not.toContain(tmpDir);
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

  describe('OAuth endpoints', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
      global.fetch = mockFetch as unknown as typeof fetch;
      oauthModule.resetOAuthState();
      process.env.SF_CLIENT_ID = 'test-client-id';
      process.env.SF_CLIENT_SECRET = 'test-client-secret';
    });

    afterEach(() => {
      global.fetch = originalFetch;
      delete process.env.SF_CLIENT_ID;
      delete process.env.SF_CLIENT_SECRET;
      oauthModule.resetOAuthState();
    });

    describe('GET /oauth/authorize', () => {
      it('returns authorization URL when OAuth is configured', async () => {
        const res = await request(app).get('/oauth/authorize').expect(200);

        expect(res.body).toHaveProperty('authorizationUrl');
        expect(res.body.authorizationUrl).toContain('response_type=code');
        expect(res.body.authorizationUrl).toContain('client_id=test-client-id');
        expect(res.body.authorizationUrl).toContain('code_challenge');
        expect(res.body.authorizationUrl).toContain('state');
        expect(res.body.authorizationUrl).toContain('code_challenge_method=S256');
      });

      it('supports custom loginUrl query param', async () => {
        const res = await request(app)
          .get('/oauth/authorize')
          .query({ loginUrl: 'https://test.salesforce.com' })
          .expect(200);

        expect(res.body.authorizationUrl).toContain('https://test.salesforce.com');
      });

      it('returns 400 when OAuth is not configured', async () => {
        delete process.env.SF_CLIENT_ID;
        delete process.env.SF_CLIENT_SECRET;
        app = createApp();

        const res = await request(app).get('/oauth/authorize').expect(400);

        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body).toMatchObject({ status: 400, title: 'OAuth Not Configured' });
      });
    });

    describe('GET /oauth/callback', () => {
      it('exchanges code for tokens and connects org on success', async () => {
        // First, get a valid authorization URL to extract the state
        const authRes = await request(app).get('/oauth/authorize').expect(200);
        const authUrl = new URL(authRes.body.authorizationUrl);
        const state = authUrl.searchParams.get('state');

        // Mock the token exchange response
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'test-access-token',
            instance_url: 'https://test.salesforce.com',
            id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        });

        const res = await request(app)
          .get('/oauth/callback')
          .query({ code: 'test-code', state })
          .expect(200);

        expect(res.text).toContain('Authentication successful');
        expect(mockFetch).toHaveBeenCalled();
      });

      it('handles Salesforce error parameters', async () => {
        const res = await request(app)
          .get('/oauth/callback')
          .query({ error: 'access_denied', error_description: 'user+denied' })
          .expect(200);

        expect(res.text).toContain('Authentication Failed');
        expect(res.text).toContain('access_denied');
      });

      it('returns error page when code is missing', async () => {
        const res = await request(app)
          .get('/oauth/callback')
          .query({ state: 'invalid-state' })
          .expect(200);

        expect(res.text).toContain('Authentication Failed');
      });

      it('returns error page when state is invalid', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'test-token',
            instance_url: 'https://test.salesforce.com',
            id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        });

        const res = await request(app)
          .get('/oauth/callback')
          .query({ code: 'test-code', state: 'invalid-state' })
          .expect(200);

        expect(res.text).toContain('Authentication Failed');
      });

      it('returns error page when token exchange fails', async () => {
        const authRes = await request(app).get('/oauth/authorize').expect(200);
        const authUrl = new URL(authRes.body.authorizationUrl);
        const state = authUrl.searchParams.get('state');

        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => 'Invalid request',
        });

        const res = await request(app)
          .get('/oauth/callback')
          .query({ code: 'test-code', state })
          .expect(200);

        expect(res.text).toContain('Authentication Failed');
      });

      it('returns error page when write lock is held', async () => {
        const authRes = await request(app).get('/oauth/authorize').expect(200);
        const authUrl = new URL(authRes.body.authorizationUrl);
        const state = authUrl.searchParams.get('state');

        await request(app).post('/internal/lock').expect(200);

        const res = await request(app)
          .get('/oauth/callback')
          .query({ code: 'test-code', state })
          .expect(200);

        expect(res.text).toContain('Authentication Failed');
        expect(res.text).toContain('busy');
      });
    });

    describe('GET /oauth/status', () => {
      it('returns not authenticated when no session', async () => {
        const res = await request(app).get('/oauth/status').expect(200);

        expect(res.body).toEqual({ authenticated: false });
      });

      it('returns authenticated status after successful callback', async () => {
        const authRes = await request(app).get('/oauth/authorize').expect(200);
        const authUrl = new URL(authRes.body.authorizationUrl);
        const state = authUrl.searchParams.get('state');

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'test-access-token',
            instance_url: 'https://test.salesforce.com',
            id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        });

        // Also mock org name fetch as non-fatal
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ Name: 'Test Org' }),
        });

        await request(app)
          .get('/oauth/callback')
          .query({ code: 'test-code', state })
          .expect(200);

        const res = await request(app).get('/oauth/status').expect(200);

        expect(res.body.authenticated).toBe(true);
        expect(res.body.instanceUrl).toBe('https://test.salesforce.com');
        expect(res.body.orgId).toBe('00Dxx0000000000');
        expect(res.body.userId).toBe('005xx000000000Z');
      });
    });

    describe('POST /oauth/disconnect', () => {
      it('clears session and returns 204', async () => {
        const authRes = await request(app).get('/oauth/authorize').expect(200);
        const authUrl = new URL(authRes.body.authorizationUrl);
        const state = authUrl.searchParams.get('state');

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'test-access-token',
            instance_url: 'https://test.salesforce.com',
            id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        });

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ Name: 'Test Org' }),
        });

        await request(app)
          .get('/oauth/callback')
          .query({ code: 'test-code', state })
          .expect(200);

        await request(app).post('/oauth/disconnect').expect(204);

        const res = await request(app).get('/oauth/status').expect(200);
        expect(res.body).toEqual({ authenticated: false });
      });

      it('returns 204 when no session exists (idempotent)', async () => {
        await request(app).post('/oauth/disconnect').expect(204);
      });
    });
  });
});
