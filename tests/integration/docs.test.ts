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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('OpenAPI documentation', () => {
  const app = createApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /docs should redirect or serve the Swagger UI', async () => {
    const res = await request(app.server).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger');
  });

  it('GET /openapi.json should return a valid OpenAPI 3.0 spec', async () => {
    const res = await request(app.server).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.0');
    expect(res.body.info.title).toBe('SF Project Service');
    expect(res.body.paths).toBeDefined();

    const paths = Object.keys(res.body.paths);
    expect(paths).toContain('/v1/templates');
    expect(paths).toContain('/v1/projects');
    expect(paths).toContain('/v1/projects/{id}/tree');
    expect(paths).toContain('/v1/projects/{id}/deployments');
  });
});
