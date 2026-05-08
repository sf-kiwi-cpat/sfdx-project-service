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
        description: 'REST API wrapping an SFDX project for remote IDE-like operations',
      },
      // When set (e.g. ROUTING_PREFIX=/project-service), swagger-ui uses this as the
      // base URL for "Try it out" requests so they route correctly through the proxy.
      ...(process.env.ROUTING_PREFIX ? { servers: [{ url: process.env.ROUTING_PREFIX }] } : {}),
    },
  });

  app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  app.get('/openapi.json', async (_request, reply) => {
    return reply.send(app.swagger());
  });

  // Health check — root-level liveness probe (not behind /v1 prefix)
  app.get('/health', async (_request, reply) => {
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
