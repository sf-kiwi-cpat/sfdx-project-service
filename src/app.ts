import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { logger } from './logger.js';
import { routes } from './routes/index.js';
import { errorToProblem, problemDetail, PROBLEM_JSON } from './errors.js';

/**
 * Create and configure the Fastify app. Exported for testing.
 */
export function createApp() {
  const app = Fastify({ loggerInstance: logger });

  app.register(fastifySwagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'SF Project Service',
        version: '1.0.0',
        description: 'REST API wrapping an SFDX project for remote IDE-like operations',
      },
    },
  });

  app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  app.get('/openapi.json', async (_request, reply) => {
    return reply.send(app.swagger());
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
