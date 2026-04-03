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
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { logger } from './logger.js';
import { routes } from './routes/index.js';
import { errorToProblem, problemDetail, PROBLEM_JSON } from './errors.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

/**
 * Create and configure the Fastify app. Exported for testing.
 */
export function createApp() {
  const app = Fastify({ loggerInstance: logger });

  app.register(fastifyCors, { origin: true });

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

  return app;
}
