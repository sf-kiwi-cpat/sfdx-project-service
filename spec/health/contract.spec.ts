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

/**
 * SPEC TESTS — Human-guarded contract (SDLC 2026)
 *
 * These tests define the contract for GET /health.
 * They are the source of truth for this endpoint's external behavior.
 * The AI implementation agent must NOT modify this file.
 *
 * Issue: #71 — Add a health check endpoint
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('GET /health', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    app = createApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 OK', async () => {
    await request(app.server).get('/health').expect(200);
  });

  it('returns JSON with { status: "ok" }', async () => {
    const res = await request(app.server).get('/health').expect('Content-Type', /json/).expect(200);

    expect(res.body).toEqual({ status: 'ok' });
  });

  it('is not behind the /v1 prefix', async () => {
    // /health lives at the root, not under /v1
    await request(app.server).get('/health').expect(200);
    await request(app.server).get('/v1/health').expect(404);
  });

  it('responds without authentication', async () => {
    // No auth headers needed — this is an internal liveness probe
    const res = await request(app.server).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });
});
