import express from 'express';
import { pinoHttp } from 'pino-http';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { logger } from './logger.js';
import { createRouter } from './routes.js';
import { errorToProblem, problemDetail, PROBLEM_JSON } from './errors.js';

/**
 * Create and configure the Express app. Exported for testing.
 */
export function createApp(): express.Application {
  const app = express();

  app.use(
    pinoHttp({
      logger,
      customLogLevel: (
        _req: express.Request,
        res: express.Response,
        err?: Error
      ): 'error' | 'warn' | 'info' => {
        if (res.statusCode >= 500 || err) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    })
  );

  app.use(express.json());

  const swaggerSpec = swaggerJsdoc({
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'SF Project Service',
        version: '1.0.0',
        description: 'REST API wrapping an SFDX project for remote IDE-like operations',
      },
    },
    apis: ['./src/routes.ts', './dist/routes.js'],
  });

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/openapi.json', (_req, res) => res.json(swaggerSpec));

  app.use(createRouter());

  // Catch-all for unknown routes — return RFC 9457 JSON, not Express's default HTML
  app.use((req: express.Request, res: express.Response) => {
    res
      .status(404)
      .contentType(PROBLEM_JSON)
      .json(problemDetail(404, 'Not Found', `Cannot ${req.method} ${req.path}`));
  });

  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (res.headersSent) return;

      const problem = errorToProblem(err);
      if (problem.status >= 500) {
        const stack = err instanceof Error ? err.stack : undefined;
        logger.error({ err, stack }, 'Unhandled error');
      }

      res.status(problem.status).contentType(PROBLEM_JSON).json(problem);
    }
  );

  return app;
}
