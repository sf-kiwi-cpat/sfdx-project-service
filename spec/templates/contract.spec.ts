/*
 * Copyright (c) 2026, Salesforce, Inc.
 * SPDX-License-Identifier: Apache-2
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
 * These tests define the contract for GET /templates.
 * They are the source of truth for this endpoint's external behavior.
 * The AI implementation agent must NOT modify this file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('GET /templates', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    app = createApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with an array of template objects', async () => {
    const res = await request(app.server).get('/v1/templates').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('each template has name and id fields', async () => {
    const res = await request(app.server).get('/v1/templates').expect(200);
    for (const template of res.body) {
      expect(template).toHaveProperty('id');
      expect(template).toHaveProperty('name');
      expect(typeof template.id).toBe('string');
      expect(typeof template.name).toBe('string');
    }
  });

  it('lists the hello-world-1 and hello-world-2 templates', async () => {
    const res = await request(app.server).get('/v1/templates').expect(200);
    const ids = res.body.map((t: { id: string }) => t.id);
    expect(ids).toContain('hello-world-1');
    expect(ids).toContain('hello-world-2');
  });
});
