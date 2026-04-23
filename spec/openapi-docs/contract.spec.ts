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
 * consumer needs: summary, description, tags, response schemas for
 * real status codes, parameter descriptions, field descriptions, and
 * documented auth. Because the "every operation" invariants enumerate
 * dynamically over `paths`, new routes are automatically covered —
 * you can't add an undocumented endpoint without breaking this spec.
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

type Response = {
  description?: string;
  content?: Record<string, { schema?: unknown }>;
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
      it(`${method} ${path} declares ${code} with a response schema`, () => {
        const op = getOp(spec, method, path);
        const resp = op.responses?.[code];
        expect(resp, `${method} ${path} must declare ${code}`).toBeDefined();
        // SSE endpoints declare text/event-stream; everything else declares a JSON schema.
        const content = resp!.content ?? {};
        const contentTypes = Object.keys(content);
        expect(
          contentTypes.length,
          `${method} ${path} response ${code} must declare a content type`
        ).toBeGreaterThan(0);
        for (const ct of contentTypes) {
          expect(
            content[ct].schema,
            `${method} ${path} response ${code} (${ct}) must declare a schema`
          ).toBeDefined();
        }
      });
    }
  });

  describe('SSE endpoints declare text/event-stream', () => {
    const sseEndpoints: Array<{ method: string; path: string }> = [
      { method: 'GET', path: '/v1/projects/{id}/deployments/{deploymentId}/events' },
      { method: 'GET', path: '/v1/projects/{id}/fs/events' },
    ];

    for (const { method, path } of sseEndpoints) {
      it(`${method} ${path} declares 200 with text/event-stream`, () => {
        const op = getOp(spec, method, path);
        const resp = op.responses?.['200'];
        expect(resp).toBeDefined();
        expect(resp!.content?.['text/event-stream']).toBeDefined();
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

  describe('Authentication', () => {
    it('declares a bearer securityScheme for the access token', () => {
      const schemes = spec.components?.securitySchemes ?? {};
      const bearerSchemes = Object.values(schemes).filter(
        (s) => s.type === 'http' && s.scheme === 'bearer'
      );
      expect(bearerSchemes.length).toBeGreaterThan(0);
    });

    it('POST /v1/projects/{id}/deployments references a bearer security scheme', () => {
      const op = getOp(spec, 'POST', '/v1/projects/{id}/deployments');
      const schemes = spec.components?.securitySchemes ?? {};
      const bearerNames = new Set(
        Object.entries(schemes)
          .filter(([, s]) => s.type === 'http' && s.scheme === 'bearer')
          .map(([name]) => name)
      );
      const security = op.security ?? [];
      const referenced = security.some((req) =>
        Object.keys(req).some((name) => bearerNames.has(name))
      );
      expect(referenced).toBe(true);
    });

    it('POST /v1/projects/{id}/deployments declares the X-Salesforce-Instance-Url header parameter', () => {
      const op = getOp(spec, 'POST', '/v1/projects/{id}/deployments');
      const instanceUrlHeader = (op.parameters ?? []).find(
        (p) => p.in === 'header' && p.name.toLowerCase() === 'x-salesforce-instance-url'
      );
      expect(instanceUrlHeader).toBeDefined();
      expect((instanceUrlHeader!.description ?? '').trim().length).toBeGreaterThan(0);
    });
  });
});
