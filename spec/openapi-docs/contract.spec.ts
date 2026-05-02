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
 * These tests define the contract for the OpenAPI document served at
 * /openapi.json (and rendered by Swagger UI at /docs). The document is
 * itself a consumer-facing surface — AI coding assistants and humans
 * both rely on it to build correct clients against this API. Thin docs
 * cause consumers to hallucinate shapes (e.g., a prior incident where
 * an assistant invented a `name` field on POST /v1/projects because
 * the GET response included one).
 *
 * The contract asserts STRUCTURAL COMPLETENESS, not prose. It never
 * pins specific wording — only that every route declares what a
 * consumer needs: summary, description, tags, response schemas (with
 * a concrete $ref or type — not an empty `{}`) for real status codes,
 * non-JSON content types pinned where they matter (text/plain,
 * text/event-stream), application/problem+json for every 4xx response
 * (matching the real RFC 9457 responses the service returns),
 * parameter descriptions, field descriptions, and a documented
 * credential input for the deploy endpoint (zero-auth surface —
 * `orgAlias` in the request body, no header-based credentials).
 * Because the "every operation" invariants enumerate dynamically over
 * `paths`, new routes are automatically covered — you can't add an
 * undocumented endpoint without breaking this spec.
 *
 * The AI implementation agent must NOT modify this file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

type Parameter = {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: unknown;
};

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  $ref?: string;
  required?: string[];
  items?: Schema;
  description?: string;
};

type Response = {
  description?: string;
  content?: Record<string, { schema?: Schema }>;
};

type Operation = {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: {
    content?: Record<
      string,
      { schema?: { properties?: Record<string, { description?: string }> } }
    >;
  };
  responses?: Record<string, Response>;
  security?: Array<Record<string, string[]>>;
};

type OpenApiDoc = {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, Operation>>;
  tags?: Array<{ name: string; description?: string }>;
  components?: {
    securitySchemes?: Record<
      string,
      { type?: string; scheme?: string; in?: string; name?: string }
    >;
    schemas?: Record<string, Schema>;
  };
};

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

type OperationEntry = { path: string; method: string; op: Operation };

function allOperations(spec: OpenApiDoc): OperationEntry[] {
  const entries: OperationEntry[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, Operation>)[method];
      if (op) entries.push({ path, method: method.toUpperCase(), op });
    }
  }
  return entries;
}

function label(entry: OperationEntry): string {
  return `${entry.method} ${entry.path}`;
}

/** Look up an operation by method+path, throwing if absent (so the route being gone fails loud). */
function getOp(spec: OpenApiDoc, method: string, path: string): Operation {
  const pathItem = spec.paths?.[path];
  const op = pathItem?.[method.toLowerCase()];
  if (!op) {
    throw new Error(
      `Expected operation ${method} ${path} to exist in OpenAPI doc, but it was missing`
    );
  }
  return op;
}

describe('OpenAPI document completeness', () => {
  let app: ReturnType<typeof createApp>;
  let spec: OpenApiDoc;

  beforeEach(async () => {
    app = createApp();
    await app.ready();
    spec = app.swagger() as OpenApiDoc;
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Document-level metadata', () => {
    it('serves the OpenAPI JSON at /openapi.json with a valid OpenAPI 3.x document', async () => {
      const res = await request(app.server).get('/openapi.json').expect(200);
      expect(res.body.openapi).toMatch(/^3\./);
      expect(res.body.info?.title).toBeTruthy();
      expect(res.body.info?.version).toBeTruthy();
      expect(res.body.paths).toBeDefined();
      expect(Object.keys(res.body.paths).length).toBeGreaterThan(0);
    });

    it('serves the Swagger UI at /docs', async () => {
      const res = await request(app.server).get('/docs/').expect(200);
      expect(res.headers['content-type']).toMatch(/html/);
    });

    it('declares a non-empty info.description', () => {
      expect(spec.info?.description).toBeTruthy();
      expect((spec.info?.description ?? '').trim().length).toBeGreaterThan(0);
    });

    it('declares at least one document-level tag with a description', () => {
      expect(Array.isArray(spec.tags)).toBe(true);
      expect((spec.tags ?? []).length).toBeGreaterThan(0);
      for (const tag of spec.tags ?? []) {
        expect(tag.name).toBeTruthy();
        expect((tag.description ?? '').trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('Every operation', () => {
    it('has a non-empty summary', () => {
      const offenders = allOperations(spec)
        .filter((e) => !e.op.summary || e.op.summary.trim().length === 0)
        .map(label);
      expect(offenders).toEqual([]);
    });

    it('has a non-empty description', () => {
      const offenders = allOperations(spec)
        .filter((e) => !e.op.description || e.op.description.trim().length === 0)
        .map(label);
      expect(offenders).toEqual([]);
    });

    it('declares at least one tag, and every tag is registered at the document level', () => {
      const registered = new Set((spec.tags ?? []).map((t) => t.name));
      const offenders: string[] = [];
      for (const entry of allOperations(spec)) {
        const tags = entry.op.tags ?? [];
        if (tags.length === 0) {
          offenders.push(`${label(entry)}: no tags`);
          continue;
        }
        for (const t of tags) {
          if (!registered.has(t)) offenders.push(`${label(entry)}: tag "${t}" not registered`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('declares a description on every response', () => {
      const offenders: string[] = [];
      for (const entry of allOperations(spec)) {
        for (const [status, resp] of Object.entries(entry.op.responses ?? {})) {
          if (!resp.description || resp.description.trim().length === 0) {
            offenders.push(`${label(entry)} → ${status}: missing description`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it('declares a description on every parameter', () => {
      const offenders: string[] = [];
      for (const entry of allOperations(spec)) {
        for (const p of entry.op.parameters ?? []) {
          if (!p.description || p.description.trim().length === 0) {
            offenders.push(`${label(entry)} param ${p.in}/${p.name}: missing description`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it('declares a description on every top-level request body property', () => {
      const offenders: string[] = [];
      for (const entry of allOperations(spec)) {
        const body = entry.op.requestBody;
        if (!body) continue;
        const jsonSchema = body.content?.['application/json']?.schema;
        const props = (jsonSchema as { properties?: Record<string, { description?: string }> })
          ?.properties;
        if (!props) continue;
        for (const [name, propSchema] of Object.entries(props)) {
          if (!propSchema.description || propSchema.description.trim().length === 0) {
            offenders.push(`${label(entry)} body.${name}: missing description`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  describe('Success response codes (exact code per route)', () => {
    // Each entry declares the code the route actually returns today. The contract
    // pins the exact code — accidentally changing 202→200 on deployments would
    // break client polling assumptions and should fail the contract, not silently
    // slip through.
    const expectations: Array<{ method: string; path: string; code: string }> = [
      { method: 'GET', path: '/v1/templates', code: '200' },
      { method: 'POST', path: '/v1/projects', code: '201' },
      { method: 'GET', path: '/v1/projects', code: '200' },
      { method: 'PATCH', path: '/v1/projects/{id}', code: '200' },
      { method: 'GET', path: '/v1/projects/{id}/file', code: '200' },
      { method: 'GET', path: '/v1/projects/{id}/tree', code: '200' },
      { method: 'POST', path: '/v1/projects/{id}/deployments', code: '202' },
      {
        method: 'GET',
        path: '/v1/projects/{id}/deployments/{deploymentId}/events',
        code: '200',
      },
      { method: 'GET', path: '/v1/projects/{id}/fs/events', code: '200' },
    ];

    for (const { method, path, code } of expectations) {
      it(`${method} ${path} declares ${code} with a non-empty response schema`, () => {
        const op = getOp(spec, method, path);
        const resp = op.responses?.[code];
        expect(resp, `${method} ${path} must declare ${code}`).toBeDefined();
        const content = resp!.content ?? {};
        const contentTypes = Object.keys(content);
        expect(
          contentTypes.length,
          `${method} ${path} response ${code} must declare a content type`
        ).toBeGreaterThan(0);
        for (const ct of contentTypes) {
          const schema = content[ct].schema;
          expect(
            schema,
            `${method} ${path} response ${code} (${ct}) must declare a schema`
          ).toBeDefined();
          // Closes the `schema: {}` loophole — an empty schema conveys nothing
          // to consumers. Require either a $ref or a concrete type without
          // pinning the shape itself.
          const hasStructure = Boolean(schema?.$ref) || Boolean(schema?.type);
          expect(
            hasStructure,
            `${method} ${path} response ${code} (${ct}) schema must declare $ref or type`
          ).toBe(true);
        }
      });
    }
  });

  describe('Non-JSON content types are pinned where they matter', () => {
    // When a route intentionally returns something other than JSON, pin the
    // content type so it can't be silently re-documented as application/json.
    const nonJsonExpectations: Array<{
      method: string;
      path: string;
      code: string;
      contentType: string;
    }> = [
      { method: 'GET', path: '/v1/projects/{id}/file', code: '200', contentType: 'text/plain' },
      {
        method: 'GET',
        path: '/v1/projects/{id}/deployments/{deploymentId}/events',
        code: '200',
        contentType: 'text/event-stream',
      },
      {
        method: 'GET',
        path: '/v1/projects/{id}/fs/events',
        code: '200',
        contentType: 'text/event-stream',
      },
    ];

    for (const { method, path, code, contentType } of nonJsonExpectations) {
      it(`${method} ${path} declares ${code} with ${contentType}`, () => {
        const op = getOp(spec, method, path);
        const resp = op.responses?.[code];
        expect(resp).toBeDefined();
        expect(resp!.content?.[contentType]).toBeDefined();
      });
    }
  });

  describe('Documented error responses', () => {
    it('POST /v1/projects/{id}/deployments declares 400 (no auth available)', () => {
      const op = getOp(spec, 'POST', '/v1/projects/{id}/deployments');
      expect(op.responses?.['400']).toBeDefined();
    });

    it('GET /v1/projects/{id}/deployments/{deploymentId}/events declares 404 (unknown deployment)', () => {
      const op = getOp(spec, 'GET', '/v1/projects/{id}/deployments/{deploymentId}/events');
      expect(op.responses?.['404']).toBeDefined();
    });

    it('PATCH /v1/projects/{id} declares 400 (invalid name)', () => {
      const op = getOp(spec, 'PATCH', '/v1/projects/{id}');
      expect(op.responses?.['400']).toBeDefined();
    });

    it('routes that resolve a project id declare 404 (unknown project)', () => {
      const projectIdRoutes: Array<{ method: string; path: string }> = [
        { method: 'PATCH', path: '/v1/projects/{id}' },
        { method: 'GET', path: '/v1/projects/{id}/file' },
        { method: 'GET', path: '/v1/projects/{id}/tree' },
        { method: 'POST', path: '/v1/projects/{id}/deployments' },
        { method: 'GET', path: '/v1/projects/{id}/deployments/{deploymentId}/events' },
        { method: 'GET', path: '/v1/projects/{id}/fs/events' },
      ];
      const offenders: string[] = [];
      for (const { method, path } of projectIdRoutes) {
        const op = getOp(spec, method, path);
        if (!op.responses?.['404']) offenders.push(`${method} ${path}`);
      }
      expect(offenders).toEqual([]);
    });
  });

  describe('Error response shape (RFC 9457 problem+json)', () => {
    // The service uniformly serves errors as application/problem+json per
    // src/errors.ts (PROBLEM_JSON, problemDetail). The OpenAPI doc must
    // advertise that same media type — otherwise consumers build error
    // handling against application/json and are surprised in production.

    it('declares a reusable Problem schema in components.schemas with the RFC 9457 fields', () => {
      const schemas = spec.components?.schemas ?? {};
      // The exact schema name is not pinned; any schema whose required fields
      // match the RFC 9457 shape (status, title, detail) counts.
      const candidates = Object.values(schemas).filter((s) => {
        const props = s.properties ?? {};
        return 'status' in props && 'title' in props && 'detail' in props;
      });
      expect(
        candidates.length,
        'components.schemas must declare a reusable Problem schema with status/title/detail'
      ).toBeGreaterThan(0);
    });

    it('every documented 4xx response declares application/problem+json with a schema', () => {
      const offenders: string[] = [];
      for (const entry of allOperations(spec)) {
        for (const [status, resp] of Object.entries(entry.op.responses ?? {})) {
          if (!/^4\d\d$/.test(status)) continue;
          const problem = resp.content?.['application/problem+json'];
          if (!problem) {
            offenders.push(`${label(entry)} → ${status}: missing application/problem+json`);
            continue;
          }
          const schema = problem.schema;
          const hasStructure = Boolean(schema?.$ref) || Boolean(schema?.type);
          if (!hasStructure) {
            offenders.push(
              `${label(entry)} → ${status}: application/problem+json schema must declare $ref or type`
            );
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  describe('Credential input', () => {
    // The service is zero-auth over HTTP — the deploy endpoint resolves
    // credentials server-side from body `orgAlias` → project target-org →
    // global default org. The doc must advertise the one caller-supplied
    // input (`orgAlias`) with a description, and MUST NOT re-introduce
    // the retired header-based credential path (Authorization /
    // X-Salesforce-Instance-Url). If either of those headers resurfaces
    // in the OpenAPI doc, a consumer will build a broken client against
    // an input the service silently ignores.

    it('POST /v1/projects/{id}/deployments declares an orgAlias body field with a description', () => {
      const op = getOp(spec, 'POST', '/v1/projects/{id}/deployments');
      const schema = op.requestBody?.content?.['application/json']?.schema;
      const props = (schema as { properties?: Record<string, { description?: string }> })
        ?.properties;
      expect(
        props?.orgAlias,
        'orgAlias property must be declared on the request body'
      ).toBeDefined();
      expect((props!.orgAlias.description ?? '').trim().length).toBeGreaterThan(0);
    });

    it('POST /v1/projects/{id}/deployments does not declare retired header-based credentials', () => {
      const op = getOp(spec, 'POST', '/v1/projects/{id}/deployments');
      const retired = new Set(['authorization', 'x-salesforce-instance-url']);
      const offenders = (op.parameters ?? [])
        .filter((p) => p.in === 'header' && retired.has(p.name.toLowerCase()))
        .map((p) => p.name);
      expect(offenders).toEqual([]);
    });

    it('does not declare a retired header-based security scheme on any operation', () => {
      // Belt-and-suspenders for the whole doc: even if a future route added
      // bearer/basic auth back in, that would contradict the zero-auth
      // contract. Catch it here rather than at runtime.
      const schemes = spec.components?.securitySchemes ?? {};
      const offenders = Object.entries(schemes)
        .filter(([, s]) => s.type === 'http' && (s.scheme === 'bearer' || s.scheme === 'basic'))
        .map(([name]) => name);
      expect(offenders).toEqual([]);
    });
  });
});
