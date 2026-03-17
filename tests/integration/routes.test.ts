import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('SF Project Service API', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  describe('Unknown routes', () => {
    it('returns 404 with RFC 9457 JSON for nonexistent path', async () => {
      const res = await request(app).get('/nonexistent').expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 404, title: 'Not Found' });
      expect(res.body.detail).toContain('Cannot GET');
    });

    it('returns 404 with RFC 9457 JSON for wrong method on valid path', async () => {
      const res = await request(app).delete('/templates').expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 404, title: 'Not Found' });
    });
  });
});
