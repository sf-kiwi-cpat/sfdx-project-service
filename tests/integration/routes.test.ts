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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('SFDX Project Service API', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    app = createApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Unknown routes', () => {
    it('returns 404 with RFC 9457 JSON for nonexistent path', async () => {
      const res = await request(app.server).get('/nonexistent').expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 404, title: 'Not Found' });
      expect(res.body.detail).toContain('Cannot GET');
    });

    it('returns 404 with RFC 9457 JSON for wrong method on valid path', async () => {
      const res = await request(app.server).delete('/v1/templates').expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 404, title: 'Not Found' });
    });
  });

  describe('Error handler', () => {
    it('returns 500 with generic message for non-Error thrown values', async () => {
      // Mock listTemplates to reject with a string (not an Error instance)
      const templates = await import('../../src/domain/templates.js');
      vi.spyOn(templates, 'listTemplates').mockRejectedValueOnce('unexpected string error');

      const res = await request(app.server).get('/v1/templates').expect(500);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({
        status: 500,
        title: 'Internal Server Error',
        detail: 'Internal server error',
      });

      vi.restoreAllMocks();
    });

    it('returns 500 with error message for Error instances', async () => {
      const templates = await import('../../src/domain/templates.js');
      vi.spyOn(templates, 'listTemplates').mockRejectedValueOnce(new Error('disk read failed'));

      const res = await request(app.server).get('/v1/templates').expect(500);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({
        status: 500,
        title: 'Internal Server Error',
        detail: 'disk read failed',
      });

      vi.restoreAllMocks();
    });
  });
});
