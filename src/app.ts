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

import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifySSE from '@fastify/sse';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { logger } from './logger.js';
import { routes } from './routes/index.js';
import { errorToProblem, problemDetail, PROBLEM_JSON } from './errors.js';
import { watcherManager } from './domain/watcher.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

/**
 * Create and configure the Fastify app. Exported for testing.
 *
 * No explicit `: FastifyInstance` return type: passing `loggerInstance`
 * narrows the inferred Logger generic from `FastifyBaseLogger` to pino's
 * concrete `Logger<...>`, and pinning the default annotation here causes
 * a build error. Let TypeScript infer it. (See src/CLAUDE.md.)
 */
export function createApp() {
  const app = Fastify({
    // Fastify 5 renamed this option from `logger` to `loggerInstance` for
    // pre-built pino instances. Using `logger` with an instance throws
    // "logger options only accepts a configuration object" at runtime.
    loggerInstance: logger,
    // Override @fastify/ajv-compiler defaults: `removeAdditional: true` would
    // silently strip unknown properties before `additionalProperties: false`
    // could reject them. Setting it to false lets schema validation surface
    // typos and unsupported fields instead of hiding them.
    ajv: { customOptions: { removeAdditional: false } },
    // Default formatter produces "body must NOT have additional properties"
    // without naming the offending key. Callers need the property name to
    // identify the typo — append it when the keyword is additionalProperties.
    schemaErrorFormatter: (errors, dataVar) => {
      const parts: string[] = [];
      for (const e of errors) {
        let message = `${dataVar}${e.instancePath || ''} ${e.message}`;
        if (
          e.keyword === 'additionalProperties' &&
          typeof (e.params as { additionalProperty?: unknown })?.additionalProperty === 'string'
        ) {
          const key = (e.params as { additionalProperty: string }).additionalProperty;
          message += `: '${key}'`;
        }
        parts.push(message);
      }
      return new Error(parts.join(', '));
    },
  });

  app.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  });

  // SSE routes opt in via `{ sse: true }`. 15s heartbeat matches the pre-plugin
  // hand-rolled cadence so nginx/proxies tuned to the old interval keep
  // working unchanged. `.default` is the CJS→ESM interop shape: the plugin
  // ships CJS with an ESM-style .d.ts, so TypeScript needs `.default` to type
  // the register call (runtime resolves to the same function either way).
  app.register(fastifySSE.default, { heartbeatInterval: 15_000 });

  app.register(fastifySwagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'SFDX Project Service',
        version: pkg.version,
        description:
          'REST API wrapping an SFDX project for remote IDE-like operations. ' +
          'Provides endpoints for scaffolding projects from templates, reading ' +
          'project files and directory trees, deploying metadata to a Salesforce ' +
          'org, and subscribing to filesystem change events over Server-Sent ' +
          'Events. All errors are returned as RFC 9457 application/problem+json ' +
          'responses.',
      },
      tags: [
        {
          name: 'Templates',
          description: 'Discover the catalog of SFDX project templates available for scaffolding.',
        },
        {
          name: 'Projects',
          description: 'Create, list, rename, and introspect SFDX projects managed by the service.',
        },
        {
          name: 'Deployments',
          description:
            'Initiate asynchronous metadata deployments to a Salesforce org and ' +
            'observe their progress over Server-Sent Events.',
        },
        {
          name: 'Filesystem events',
          description:
            'Subscribe to real-time add, change, and unlink events for a project ' +
            'tree via Server-Sent Events. Initial chokidar scan completes before ' +
            'the first event so writes immediately after `connected` are reported ' +
            'correctly.',
        },
      ],
      // When set (e.g. ROUTING_PREFIX=/project-service), swagger-ui uses this as the
      // base URL for "Try it out" requests so they route correctly through the proxy.
      ...(process.env.ROUTING_PREFIX ? { servers: [{ url: process.env.ROUTING_PREFIX }] } : {}),
    },
  });

  // Register the RFC 9457 Problem schema once. Routes reference it via
  // `$ref: 'Problem#'` in their response schemas; fastify's response serializer
  // resolves the ref at validate-time, and @fastify/swagger lifts the schema
  // into `components.schemas.Problem` in the emitted OpenAPI doc.
  app.addSchema({
    $id: 'Problem',
    type: 'object',
    description:
      'RFC 9457 Problem Details. Every error response returned by this service ' +
      'conforms to this shape and is served as `application/problem+json`.',
    required: ['status', 'title', 'detail'],
    additionalProperties: true,
    properties: {
      status: {
        type: 'integer',
        description: 'HTTP status code mirror, included for client convenience.',
      },
      title: {
        type: 'string',
        description: 'Short, human-readable summary of the problem type.',
      },
      detail: {
        type: 'string',
        description: 'Human-readable explanation specific to this occurrence.',
      },
      type: {
        type: 'string',
        description:
          'Optional URI identifying the problem type. Defaults to `about:blank` per RFC 9457.',
      },
      instance: {
        type: 'string',
        description: 'Optional URI identifying the specific occurrence of the problem.',
      },
    },
  });

  app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  // The OpenAPI JSON endpoint and Swagger UI routes aren't themselves part of
  // the documented API contract (they are the documentation). We hide them
  // from the emitted OpenAPI document so the "every operation" invariants in
  // the contract apply only to real API routes.
  app.get('/openapi.json', { schema: { hide: true } }, async (_request, reply) => {
    return reply.send(app.swagger());
  });

  // Health check — root-level liveness probe (not behind /v1 prefix). Hidden
  // from the OpenAPI doc since it is an ops surface, not a consumer surface;
  // if it becomes public, document it explicitly.
  app.get('/health', { schema: { hide: true } }, async (_request, reply) => {
    return reply.send({ status: 'ok' });
  });

  app.register(routes, { prefix: '/v1' });

  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .type(PROBLEM_JSON)
      .send(problemDetail(404, 'Not Found', `Cannot ${request.method} ${request.url}`));
  });

  app.setErrorHandler((err, _request, reply) => {
    const problem = errorToProblem(err);
    if (problem.status >= 500) {
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error({ err, stack }, 'Unhandled error');
    }

    reply.status(problem.status).type(PROBLEM_JSON).send(problem);
  });

  // Close any active filesystem watchers on graceful shutdown. Prevents
  // leaked chokidar instances between test runs and during SIGTERM.
  app.addHook('onClose', async () => {
    await watcherManager.closeAll();
  });

  return app;
}
