/**
 * SPEC TESTS — Human-guarded contract (SDLC 2026)
 *
 * These tests define the contract for GET /templates.
 * They are the source of truth for this endpoint's external behavior.
 * The AI implementation agent must NOT modify this file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('GET /templates', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  it('returns 200 with an array of template objects', async () => {
    const res = await request(app).get('/templates').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('each template has name and id fields', async () => {
    const res = await request(app).get('/templates').expect(200);
    for (const template of res.body) {
      expect(template).toHaveProperty('id');
      expect(template).toHaveProperty('name');
      expect(typeof template.id).toBe('string');
      expect(typeof template.name).toBe('string');
    }
  });

  it('lists the hello-world-1 and hello-world-2 templates', async () => {
    const res = await request(app).get('/templates').expect(200);
    const ids = res.body.map((t: { id: string }) => t.id);
    expect(ids).toContain('hello-world-1');
    expect(ids).toContain('hello-world-2');
  });
});
