import express from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from './logger.js';
import { createRouter } from './routes.js';
import { WriteLock } from './lock.js';
import { errorToProblem, PROBLEM_JSON } from './errors.js';

/**
 * Create and configure the Express app. Exported for testing.
 */
export function createApp(): express.Application {
  const writeLock = new WriteLock();
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
  app.use(express.text({ type: ['text/plain', 'application/octet-stream'] }));

  app.use(createRouter(writeLock));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;

    const problem = errorToProblem(err);
    if (problem.status >= 500) {
      const isNodeError = err instanceof Error;
      const stack = isNodeError ? (err as Error).stack : undefined;
      logger.error({ err, stack }, 'Unhandled error');
    }

    res.status(problem.status).contentType(PROBLEM_JSON).json(problem);
  });

  return app;
}
