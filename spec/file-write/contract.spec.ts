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

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../src/app.js';
import { MAX_PATH_LENGTH } from '../../src/errors.js';

describe('PUT /v1/projects/:id/file', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;
  let projectDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-file-write-test-'));
    process.env.PROJECTS_ROOT = tmpDir;
  });

  afterAll(async () => {
    delete process.env.PROJECTS_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    app = createApp();
    await app.ready();

    const res = await request(app.server)
      .post('/v1/projects')
      .send({ template: 'local-react-test' })
      .expect(201);
    projectId = res.body.id;
    projectDir = path.join(tmpDir, projectId);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('204 — success', () => {
    it('writes a new file and returns 204 with empty body', async () => {
      const res = await request(app.server)
        .put(`/v1/projects/${projectId}/file`)
        .send({ path: 'notes.txt', content: 'hello world' })
        .expect(204);

      expect(res.text).toBe('');
      const written = await fs.readFile(path.join(projectDir, 'notes.txt'), 'utf-8');
      expect(written).toBe('hello world');
    });

    it('overwrites an existing file (replaces, does not append)', async () => {
      const target = path.join(projectDir, 'overwrite.txt');
      await fs.writeFile(target, 'original');

      await request(app.server)
        .put(`/v1/projects/${projectId}/file`)
        .send({ path: 'overwrite.txt', content: 'replaced' })
        .expect(204);

      const written = await fs.readFile(target, 'utf-8');
      expect(written).toBe('replaced');
    });

    it('auto-creates parent directories that do not yet exist', async () => {
      await request(app.server)
        .put(`/v1/projects/${projectId}/file`)
        .send({ path: 'nested/dir/new.txt', content: 'deep' })
        .expect(204);

      const written = await fs.readFile(path.join(projectDir, 'nested/dir/new.txt'), 'utf-8');
      expect(written).toBe('deep');
    });

    it('round-trips: PUT then GET returns the same content', async () => {
      const content = 'line one\nline two\n';

      await request(app.server)
        .put(`/v1/projects/${projectId}/file`)
        .send({ path: 'roundtrip.txt', content })
        .expect(204);

      const getRes = await request(app.server)
        .get(`/v1/projects/${projectId}/file`)
        .query({ path: 'roundtrip.txt' })
        .expect(200);

      expect(getRes.text).toBe(content);
    });
  });

  describe('400 — bad request', () => {
    it('returns 400 when path field is missing', async () => {
      const res = await request(app.server)
        .put(`/v1/projects/${projectId}/file`)
        .send({ content: 'hello' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 when content field is missing', async () => {
      const res = await request(app.server)
        .put(`/v1/projects/${projectId}/file`)
        .send({ path: 'foo.txt' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 when content is not a string', async () => {
      const res = await request(app.server)
        .put(`/v1/projects/${projectId}/file`)
        .send({ path: 'foo.txt', content: 123 })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 when path is empty', async () => {
      const res = await request(app.server)
        .put(`/v1/projects/${projectId}/file`)
        .send({ path: '', content: 'hello' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 for path traversal attempts', async () => {
      const res = await request(app.server)
        .put(`/v1/projects/${projectId}/file`)
        .send({ path: '../../etc/passwd', content: 'pwned' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 for restricted paths (.git/, .sf/, node_modules/)', async () => {
      for (const p of ['.git/config', '.sf/config.json', 'node_modules/foo/index.js']) {
        const res = await request(app.server)
          .put(`/v1/projects/${projectId}/file`)
          .send({ path: p, content: 'hello' })
          .expect(400);

        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body.status).toBe(400);
      }
    });

    it('returns 400 for dotfiles at any segment (e.g., src/.env)', async () => {
      const res = await request(app.server)
        .put(`/v1/projects/${projectId}/file`)
        .send({ path: 'src/.env', content: 'SECRET=1' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 when path length is at or above MAX_PATH_LENGTH', async () => {
      const oversize = 'a'.repeat(MAX_PATH_LENGTH);

      const res = await request(app.server)
        .put(`/v1/projects/${projectId}/file`)
        .send({ path: oversize, content: 'hello' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 for unknown body fields (additionalProperties: false)', async () => {
      const res = await request(app.server)
        .put(`/v1/projects/${projectId}/file`)
        .send({ path: 'foo.txt', content: 'hello', extra: 'nope' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    });
  });

  describe('404 — not found', () => {
    it('returns 404 for a nonexistent project', async () => {
      const res = await request(app.server)
        .put('/v1/projects/00000000-0000-0000-0000-000000000000/file')
        .send({ path: 'foo.txt', content: 'hello' })
        .expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
    });
  });
});
