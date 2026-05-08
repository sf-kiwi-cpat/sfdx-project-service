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
 * SPEC TESTS — Human-guarded contract.
 *
 * These tests define the contract for the metadata visualization endpoints
 * that expose the Salesforce Metadata Visualizer framework as HTTP routes
 * a browser host (LWC, demo page, etc.) can consume:
 *
 *   - GET  /v1/projects/:id/visualize/plugins
 *       List registered visualizer plugins (id, name, filePatterns, priority).
 *
 *   - GET  /v1/projects/:id/visualize/files
 *       List files under the project root that any registered plugin can handle.
 *       Each entry has {path, fileName, pluginId}.
 *
 *   - POST /v1/projects/:id/visualize
 *       Body: {filePath} (project-relative). Invokes the plugin whose
 *       canHandle() returns true for that path. Response body:
 *       {ok: true, pluginId, data}. `data` shape is the plugin's own contract —
 *       e.g. the schema plugin returns {objects[], relationships[], metadata}.
 *
 *   - GET  /v1/projects/:id/visualize/ui/:pluginId/
 *       Returns the plugin's prebuilt React index.html, with two adaptations
 *       applied server-side:
 *         (a) `@dist/` placeholders rewritten to a path RELATIVE to the
 *             iframe URL (e.g. `../../platform/design-system/platform.css`).
 *             The relative form survives behind a reverse proxy with a path
 *             prefix; an absolute form would bypass the prefix and 404.
 *         (b) A <script> injected that defines
 *             `window.__ExtensionHostPostMessage = msg => parent.postMessage(msg, '*')`.
 *             The plugin's React app calls __ExtensionHostPostMessage internally;
 *             the parent host page relays those messages to POST /visualize
 *             and posts the result back.
 *
 *   - GET  /v1/projects/:id/visualize/ui/:pluginId/assets/*
 *       Static assets for the plugin's React bundle (hashed JS/CSS).
 *
 *   - GET  /v1/projects/:id/visualize/platform/design-system/platform.css
 *       Design-system CSS referenced by plugin HTML. Concatenates the SDK's
 *       shipped `vscode-design-system.css` with a service-bundled light-mode
 *       overlay so the canvas paints light by default outside VS Code. The
 *       overlay pins `--mv-canvas-bg` (the documented Canvas/Shell semantic
 *       token) to a light value; consumer-specific styling is explicitly
 *       out of scope of this contract.
 *
 * CORS: the LWC consumer runs on the Lightning org origin while this service
 * runs on localhost. Cross-origin fetches MUST work — verified in the CORS
 * block below.
 *
 * The `schema` plugin (ERD) is the primary target. The `flexipage` plugin
 * is incidental — it ships in @salesforce/metadata-plugins and is expected
 * to register, but is not a first-class demo artifact. Tests that exercise
 * parsing focus on schema.
 *
 * Path-traversal and project-boundary guards match the existing file-read
 * conventions in this service (see spec/file-read).
 *
 * All errors return `application/problem+json` per RFC 9457.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../src/app.js';

/**
 * Minimal SFDX project seeded into a project directory. Two custom objects
 * with a Lookup from A → B — enough for the schema plugin to emit an ERD
 * with two nodes and one relationship.
 */
async function seedSchemaFixture(projectDir: string): Promise<void> {
  const objectsRoot = path.join(projectDir, 'force-app', 'main', 'default', 'objects');
  const aDir = path.join(objectsRoot, 'SchemaTestA__c');
  const bDir = path.join(objectsRoot, 'SchemaTestB__c');
  await fs.mkdir(path.join(aDir, 'fields'), { recursive: true });
  await fs.mkdir(path.join(bDir, 'fields'), { recursive: true });

  await fs.writeFile(
    path.join(aDir, 'SchemaTestA__c.object-meta.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Schema Test A</label>
  <pluralLabel>Schema Test As</pluralLabel>
  <nameField><label>Name</label><type>Text</type></nameField>
  <deploymentStatus>Deployed</deploymentStatus>
  <sharingModel>ReadWrite</sharingModel>
</CustomObject>`
  );
  await fs.writeFile(
    path.join(aDir, 'fields', 'RelatedB__c.field-meta.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>RelatedB__c</fullName>
  <label>Related B</label>
  <type>Lookup</type>
  <referenceTo>SchemaTestB__c</referenceTo>
  <relationshipName>Related_Bs</relationshipName>
</CustomField>`
  );
  await fs.writeFile(
    path.join(bDir, 'SchemaTestB__c.object-meta.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Schema Test B</label>
  <pluralLabel>Schema Test Bs</pluralLabel>
  <nameField><label>Name</label><type>AutoNumber</type></nameField>
  <deploymentStatus>Deployed</deploymentStatus>
  <sharingModel>ReadWrite</sharingModel>
</CustomObject>`
  );
}

describe('Metadata visualization endpoints', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-visualize-test-'));
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

    // Seed the schema fixture into the created project directory so the
    // visualizer has something to discover.
    await seedSchemaFixture(path.join(tmpDir, projectId));
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /v1/projects/:id/visualize/plugins', () => {
    describe('200 — success', () => {
      it('lists registered plugins with id, name, and filePatterns', async () => {
        const res = await request(app.server)
          .get(`/v1/projects/${projectId}/visualize/plugins`)
          .expect(200);

        expect(Array.isArray(res.body.plugins)).toBe(true);
        expect(res.body.plugins.length).toBeGreaterThan(0);

        const schema = res.body.plugins.find((p: { id: string }) => p.id === 'schema');
        expect(schema).toBeDefined();
        expect(schema.name).toBeTypeOf('string');
        expect(Array.isArray(schema.filePatterns)).toBe(true);
        expect(schema.filePatterns).toContain('.object-meta.xml');
      });
    });

    describe('404 — not found', () => {
      it('returns 404 for a nonexistent project', async () => {
        const res = await request(app.server)
          .get('/v1/projects/does-not-exist/visualize/plugins')
          .expect(404);

        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body.status).toBe(404);
      });
    });
  });

  describe('GET /v1/projects/:id/visualize/files', () => {
    describe('200 — success', () => {
      it('lists metadata files under the project that a plugin can handle', async () => {
        const res = await request(app.server)
          .get(`/v1/projects/${projectId}/visualize/files`)
          .expect(200);

        expect(Array.isArray(res.body.files)).toBe(true);
        const paths = res.body.files.map((f: { path: string }) => f.path);
        expect(paths).toContain(
          'force-app/main/default/objects/SchemaTestA__c/SchemaTestA__c.object-meta.xml'
        );

        const entry = res.body.files.find((f: { path: string }) =>
          f.path.endsWith('SchemaTestA__c.object-meta.xml')
        );
        expect(entry.pluginId).toBe('schema');
        expect(entry.fileName).toBe('SchemaTestA__c.object-meta.xml');
      });

      it('uses forward slashes in paths on all platforms', async () => {
        const res = await request(app.server)
          .get(`/v1/projects/${projectId}/visualize/files`)
          .expect(200);

        for (const f of res.body.files) {
          expect(f.path).not.toContain('\\');
        }
      });

      it('omits files no registered plugin can handle', async () => {
        const res = await request(app.server)
          .get(`/v1/projects/${projectId}/visualize/files`)
          .expect(200);

        const paths = res.body.files.map((f: { path: string }) => f.path);
        expect(paths).not.toContain('sfdx-project.json');
      });
    });

    describe('404 — not found', () => {
      it('returns 404 for a nonexistent project', async () => {
        const res = await request(app.server)
          .get('/v1/projects/does-not-exist/visualize/files')
          .expect(404);

        expect(res.body.status).toBe(404);
      });
    });
  });

  describe('POST /v1/projects/:id/visualize', () => {
    describe('200 — success', () => {
      it('parses a schema metadata file and returns the ERD payload', async () => {
        const res = await request(app.server)
          .post(`/v1/projects/${projectId}/visualize`)
          .send({
            filePath:
              'force-app/main/default/objects/SchemaTestA__c/SchemaTestA__c.object-meta.xml',
          })
          .expect(200);

        expect(res.body.ok).toBe(true);
        expect(res.body.pluginId).toBe('schema');
        expect(Array.isArray(res.body.data.objects)).toBe(true);
        expect(Array.isArray(res.body.data.relationships)).toBe(true);

        const apiNames = res.body.data.objects.map((o: { apiName: string }) => o.apiName);
        expect(apiNames).toContain('SchemaTestA__c');
        expect(apiNames).toContain('SchemaTestB__c');

        const rel = res.body.data.relationships[0];
        expect(rel.sourceObject).toBe('SchemaTestA__c');
        expect(rel.targetObject).toBe('SchemaTestB__c');
        expect(rel.fieldApiName).toBe('RelatedB__c');
      });

      // An anchor with no resolvable relationships (e.g. a Lookup field whose
      // `referenceTo` target is not present in the workspace, or an object
      // with no lookup fields at all) is a valid input and produces a valid
      // single-node ERD. This matches the schema plugin's subgraph-discovery
      // behavior in its native VS Code host, validated in W-21919006 Phase 0.
      it('returns a single-object payload when the anchor has no resolvable relationships', async () => {
        // Write a lone object with no lookup fields.
        const loneDir = path.join(
          tmpDir,
          projectId,
          'force-app',
          'main',
          'default',
          'objects',
          'LoneObj__c'
        );
        await fs.mkdir(loneDir, { recursive: true });
        await fs.writeFile(
          path.join(loneDir, 'LoneObj__c.object-meta.xml'),
          `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Lone</label><pluralLabel>Lones</pluralLabel>
  <nameField><label>Name</label><type>Text</type></nameField>
  <deploymentStatus>Deployed</deploymentStatus>
  <sharingModel>ReadWrite</sharingModel>
</CustomObject>`
        );

        const res = await request(app.server)
          .post(`/v1/projects/${projectId}/visualize`)
          .send({
            filePath: 'force-app/main/default/objects/LoneObj__c/LoneObj__c.object-meta.xml',
          })
          .expect(200);

        expect(res.body.ok).toBe(true);
        expect(res.body.data.objects.length).toBe(1);
        expect(res.body.data.objects[0].apiName).toBe('LoneObj__c');
        expect(res.body.data.relationships).toEqual([]);
      });
    });

    describe('400 — bad request', () => {
      it('returns 400 when filePath is missing', async () => {
        const res = await request(app.server)
          .post(`/v1/projects/${projectId}/visualize`)
          .send({})
          .expect(400);

        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body.status).toBe(400);
      });

      it('returns 400 for path traversal attempts', async () => {
        const res = await request(app.server)
          .post(`/v1/projects/${projectId}/visualize`)
          .send({ filePath: '../../etc/passwd' })
          .expect(400);

        expect(res.body.status).toBe(400);
      });
    });

    describe('404 — not found', () => {
      it('returns 404 for a nonexistent project', async () => {
        const res = await request(app.server)
          .post('/v1/projects/does-not-exist/visualize')
          .send({ filePath: 'x.object-meta.xml' })
          .expect(404);

        expect(res.body.status).toBe(404);
      });

      it('returns 404 when filePath resolves to a nonexistent file', async () => {
        const res = await request(app.server)
          .post(`/v1/projects/${projectId}/visualize`)
          .send({
            filePath: 'force-app/main/default/objects/Nope__c/Nope__c.object-meta.xml',
          })
          .expect(404);

        expect(res.body.status).toBe(404);
      });
    });

    describe('415 — unsupported media type', () => {
      it('returns 415 when no registered plugin handles the given file type', async () => {
        // sfdx-project.json exists in every project but no plugin handles it.
        const res = await request(app.server)
          .post(`/v1/projects/${projectId}/visualize`)
          .send({ filePath: 'sfdx-project.json' })
          .expect(415);

        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body.status).toBe(415);
      });
    });
  });

  describe('GET /v1/projects/:id/visualize/ui/:pluginId/', () => {
    describe('200 — success', () => {
      it('serves the plugin React index.html', async () => {
        const res = await request(app.server)
          .get(`/v1/projects/${projectId}/visualize/ui/schema/`)
          .expect(200);

        expect(res.headers['content-type']).toContain('text/html');
        expect(res.text).toContain('<html');
        expect(res.text).toContain('<div id="root"');
      });

      it('rewrites @dist/ placeholders to a relative path against the iframe URL', async () => {
        const res = await request(app.server)
          .get(`/v1/projects/${projectId}/visualize/ui/schema/`)
          .expect(200);

        // The plugin emits `<link href="@dist/design-system/platform.css">`
        // in its index.html. That placeholder must be resolved to a relative
        // path against the iframe URL (`/v1/projects/:id/visualize/ui/:pluginId/`),
        // not an absolute path on this service's origin — the relative form
        // resolves correctly when the service is mounted behind a reverse
        // proxy with a path prefix; an absolute form bypasses the prefix
        // and 404s at the proxy. No raw `@dist/` references may escape to
        // the browser.
        expect(res.text).not.toContain('@dist/');
        expect(res.text).toContain('../../platform/design-system/platform.css');
      });

      it('injects the host-communication bootstrap script', async () => {
        const res = await request(app.server)
          .get(`/v1/projects/${projectId}/visualize/ui/schema/`)
          .expect(200);

        expect(res.text).toContain('__ExtensionHostPostMessage');
        expect(res.text).toContain('window.parent.postMessage');
      });
    });

    describe('404 — not found', () => {
      it('returns 404 for a nonexistent project', async () => {
        const res = await request(app.server)
          .get('/v1/projects/does-not-exist/visualize/ui/schema/')
          .expect(404);

        expect(res.body.status).toBe(404);
      });

      it('returns 404 for an unknown pluginId', async () => {
        const res = await request(app.server)
          .get(`/v1/projects/${projectId}/visualize/ui/does-not-exist/`)
          .expect(404);

        expect(res.body.status).toBe(404);
      });
    });
  });

  describe('GET /v1/projects/:id/visualize/ui/:pluginId/assets/:asset', () => {
    describe('200 — success', () => {
      it('serves a plugin build asset (JS) with the correct MIME type', async () => {
        // Discover the hashed asset name from the served index.html, then
        // request it. This avoids pinning test data to a specific hash.
        const index = await request(app.server)
          .get(`/v1/projects/${projectId}/visualize/ui/schema/`)
          .expect(200);

        const match = index.text.match(/\/assets\/([a-zA-Z0-9_.-]+\.js)/);
        expect(match).not.toBeNull();
        const assetName = match![1];

        const asset = await request(app.server)
          .get(`/v1/projects/${projectId}/visualize/ui/schema/assets/${assetName}`)
          .expect(200);

        expect(asset.headers['content-type']).toContain('javascript');
        expect(asset.text.length).toBeGreaterThan(0);
      });
    });

    describe('404 — not found', () => {
      it('returns 404 for a missing asset', async () => {
        const res = await request(app.server)
          .get(`/v1/projects/${projectId}/visualize/ui/schema/assets/nope-12345.js`)
          .expect(404);

        expect(res.body.status).toBe(404);
      });
    });

    // The asset route must not leak files from outside the plugin's build
    // directory. 400 (bad request) and 404 (not found) are both defensible
    // responses — the contract asserts the security property ("does not
    // serve content from outside the build dir") and accepts either.
    describe('rejects path traversal', () => {
      it('returns 4xx for path traversal within the asset route', async () => {
        const res = await request(app.server).get(
          `/v1/projects/${projectId}/visualize/ui/schema/assets/..%2F..%2Fetc%2Fpasswd`
        );

        expect([400, 404]).toContain(res.status);
        expect(res.headers['content-type']).toContain('application/problem+json');
      });
    });
  });

  describe('GET /v1/projects/:id/visualize/platform/design-system/platform.css', () => {
    describe('200 — success', () => {
      it('serves the core-sdk design-system CSS as text/css', async () => {
        const res = await request(app.server)
          .get(`/v1/projects/${projectId}/visualize/platform/design-system/platform.css`)
          .expect(200);

        expect(res.headers['content-type']).toContain('text/css');
        expect(res.text.length).toBeGreaterThan(0);
      });

      it('sets cache-control for browser reuse', async () => {
        const res = await request(app.server)
          .get(`/v1/projects/${projectId}/visualize/platform/design-system/platform.css`)
          .expect(200);

        expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
      });

      // The SDK's stylesheet (`vscode-design-system.css`) reads `--vscode-*`
      // and `--mv-*` variables that are unset outside VS Code, so the canvas
      // falls through to dark defaults. The platform host (this service)
      // appends a light-mode overlay after the SDK base CSS so the canvas
      // paints light by default. The overlay is the host's reasonable
      // default; consumer-specific styling (e.g. App Studio SLDS values)
      // is explicitly out of scope of this contract.
      //
      // The contract pins the durable layer — `--mv-*` semantic tokens —
      // because that is the documented contract surface plugin authors
      // style against (per the SDK's design-system README). A separate
      // implementation-side `--vscode-*` safety net covers the SDK's
      // base-style direct uses (body, scrollbar, anchors, focus); that
      // layer is implementation detail and intentionally not pinned here.
      it('appends a light-mode design-system overlay after the SDK base CSS so the canvas paints light by default', async () => {
        const res = await request(app.server)
          .get(`/v1/projects/${projectId}/visualize/platform/design-system/platform.css`)
          .expect(200);

        // Direction: the canvas-background semantic token resolves to a
        // light value. `--mv-canvas-bg` is the Canvas/Shell pillar token
        // for the visualization workspace background. The SDK defines it
        // with a dark fallback; the overlay redefines it to white, so a
        // match against the light hex value proves the overlay is present.
        expect(res.text).toMatch(/--mv-canvas-bg:\s*#ffffff/);

        // Cascade ordering: the overlay must appear AFTER the SDK base
        // content so its values override (not get overridden). Anchor on
        // a SDK-base-only structural selector — `::-webkit-scrollbar`
        // is defined exclusively in the SDK's reset/base block and never
        // in the overlay vocabulary.
        const sdkBaseAnchor = res.text.indexOf('::-webkit-scrollbar');
        const overlayMatch = res.text.search(/--mv-canvas-bg:\s*#ffffff/);
        expect(sdkBaseAnchor).toBeGreaterThan(-1);
        expect(overlayMatch).toBeGreaterThan(sdkBaseAnchor);
      });
    });

    describe('404 — not found', () => {
      it('returns 404 for a nonexistent project', async () => {
        const res = await request(app.server)
          .get('/v1/projects/does-not-exist/visualize/platform/design-system/platform.css')
          .expect(404);

        expect(res.body.status).toBe(404);
      });
    });
  });

  // The App Studio LWC runs on the Lightning org origin
  // (`https://<org>.lightning.force.com` or similar). Project Service runs on
  // localhost. Every visualize endpoint the LWC or its iframe calls from the
  // browser must permit cross-origin access. This is the minimum CORS
  // contract — actual allowlist shape is a configuration concern, decided
  // during implementation.
  describe('CORS — cross-origin requests from the Lightning org', () => {
    const lightningOrigin = 'https://example-org.lightning.force.com';

    it('allows a cross-origin GET /plugins from the Lightning origin', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/visualize/plugins`)
        .set('Origin', lightningOrigin)
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBeDefined();
    });

    it('responds to a preflight OPTIONS for POST /visualize', async () => {
      const res = await request(app.server)
        .options(`/v1/projects/${projectId}/visualize`)
        .set('Origin', lightningOrigin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type')
        .expect((r) => {
          expect([200, 204]).toContain(r.status);
        });

      expect(res.headers['access-control-allow-origin']).toBeDefined();
      expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
    });

    it('allows a cross-origin GET on the plugin UI route', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/visualize/ui/schema/`)
        .set('Origin', lightningOrigin)
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBeDefined();
    });
  });

  // Concurrency: two parallel POST /visualize calls on the same project
  // must each return their own correct result. This is a behavioral
  // requirement — how the implementation achieves it (request-scoped
  // engines, a serialization queue, a framework fix) is its concern.
  describe('concurrency — parallel visualize calls return their own results', () => {
    it('parallel POST /visualize calls on the same project each return their own result', async () => {
      // Seed a lone object disconnected from the A↔B subgraph. The schema
      // plugin's relationship BFS is undirected, so anchoring on B would
      // still pull in A through the reverse edge — anchoring on a
      // disconnected object is what produces a payload that's
      // unambiguously distinct from the A anchor's payload, in both
      // identity and cardinality. That distinctness is what makes this
      // test sensitive to cross-contamination between parallel calls
      // (e.g. a shared error-listener slot, a leaky engine cache, a
      // serialization bug).
      const loneDir = path.join(
        tmpDir,
        projectId,
        'force-app',
        'main',
        'default',
        'objects',
        'LoneConc__c'
      );
      await fs.mkdir(loneDir, { recursive: true });
      await fs.writeFile(
        path.join(loneDir, 'LoneConc__c.object-meta.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Lone Conc</label><pluralLabel>Lone Concs</pluralLabel>
  <nameField><label>Name</label><type>Text</type></nameField>
  <deploymentStatus>Deployed</deploymentStatus>
  <sharingModel>ReadWrite</sharingModel>
</CustomObject>`
      );

      const results = await Promise.all([
        request(app.server).post(`/v1/projects/${projectId}/visualize`).send({
          filePath: 'force-app/main/default/objects/SchemaTestA__c/SchemaTestA__c.object-meta.xml',
        }),
        request(app.server).post(`/v1/projects/${projectId}/visualize`).send({
          filePath: 'force-app/main/default/objects/LoneConc__c/LoneConc__c.object-meta.xml',
        }),
      ]);

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.every((r) => r.body.ok === true)).toBe(true);

      const apiNamesByCall = results.map((r) =>
        r.body.data.objects.map((o: { apiName: string }) => o.apiName).sort()
      );
      // First call anchored on A — connected subgraph includes A and B.
      // Second call anchored on a lone disconnected object — subgraph is
      // just that object. The two payloads differ in both identity and
      // cardinality, so any crossover between the parallel calls is
      // observable.
      expect(apiNamesByCall[0]).toEqual(['SchemaTestA__c', 'SchemaTestB__c']);
      expect(apiNamesByCall[1]).toEqual(['LoneConc__c']);
    });
  });
});
