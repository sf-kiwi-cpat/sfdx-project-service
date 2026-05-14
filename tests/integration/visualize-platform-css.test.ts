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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../src/app.js';

describe('GET /v1/projects/:id/visualize/platform/design-system/platform.css', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-platform-css-test-'));
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
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves the response as text/css with a cacheable max-age', async () => {
    const res = await request(app.server)
      .get(`/v1/projects/${projectId}/visualize/platform/design-system/platform.css`)
      .expect(200);

    expect(res.headers['content-type']).toContain('text/css');
    expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('appends the light-mode overlay after the SDK base CSS (cascade-correct)', async () => {
    const res = await request(app.server)
      .get(`/v1/projects/${projectId}/visualize/platform/design-system/platform.css`)
      .expect(200);

    // Direction: --mv-canvas-bg resolves to a light value. The SDK base
    // defines this token with a dark fallback; the overlay redefines it
    // to white.
    expect(res.text).toMatch(/--mv-canvas-bg:\s*#ffffff/);

    // Cascade ordering: the overlay must come AFTER SDK base content.
    // ::-webkit-scrollbar is in the SDK's reset block and never in the
    // overlay; --mv-canvas-bg: #ffffff exists only in the overlay.
    const sdkBaseAnchor = res.text.indexOf('::-webkit-scrollbar');
    const overlayMatch = res.text.search(/--mv-canvas-bg:\s*#ffffff/);
    expect(sdkBaseAnchor).toBeGreaterThan(-1);
    expect(overlayMatch).toBeGreaterThan(sdkBaseAnchor);
  });

  it('also overrides --vscode-* variables the SDK base styles read directly', async () => {
    // Presence-only check: the variable names are the durable signal,
    // the colors aren't part of the contract. This still catches the
    // failure mode the test was originally protecting against (the
    // safety-net block being dropped wholesale, which would manifest
    // as a body/scrollbar/anchor color regression in the rendered
    // iframe), without pinning specific palette values that legitimate
    // refinements should be free to shift.
    const res = await request(app.server)
      .get(`/v1/projects/${projectId}/visualize/platform/design-system/platform.css`)
      .expect(200);

    expect(res.text).toMatch(/--vscode-editor-background:/);
    expect(res.text).toMatch(/--vscode-foreground:/);
  });

  it('separates the SDK base from the overlay with a recognizable marker', async () => {
    // Implementation detail — the marker is informational so anyone
    // inspecting the response can see where the SDK base ends and the
    // overlay begins. Not part of the contract; pinned here so a
    // regression that quietly drops the marker is caught.
    const res = await request(app.server)
      .get(`/v1/projects/${projectId}/visualize/platform/design-system/platform.css`)
      .expect(200);

    expect(res.text).toContain('/* --- light-mode overlay --- */');
  });

  it('returns 404 for a nonexistent project', async () => {
    const res = await request(app.server)
      .get('/v1/projects/does-not-exist/visualize/platform/design-system/platform.css')
      .expect(404);

    expect(res.body.status).toBe(404);
  });
});
