import express, { Request, Response, NextFunction } from 'express';
import { problemDetail, PROBLEM_JSON } from './errors.js';
import { buildTree, readFile, writeFile, deleteFile } from './files.js';
import { logger } from './logger.js';
import { scaffoldProject, connectOrg, type InitInput } from './project.js';
import { createProjectWatcher } from './events.js';
import { WriteLock } from './lock.js';

export function createRouter(writeLock: WriteLock): express.Router {
  const router = express.Router();

  // --- Project init ---
  router.post('/project/init', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { accessToken, instanceUrl } = req.body as InitInput;
      if (!accessToken || !instanceUrl) {
        res.status(400).contentType(PROBLEM_JSON).json(
          problemDetail(400, 'Bad Request', 'accessToken and instanceUrl are required')
        );
        return;
      }

      await scaffoldProject();
      await connectOrg({ accessToken, instanceUrl });

      res.status(200).json({ ok: true, message: 'Project scaffolded and org connected' });
    } catch (err) {
      next(err);
    }
  });

  // --- Project tree ---
  router.get('/project/tree', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const tree = await buildTree();
      res.json(tree);
    } catch (err) {
      next(err);
    }
  });

  // --- Get file ---
  router.get('/project/file', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pathParam = req.query.path as string;
      if (!pathParam) {
        res.status(400).contentType(PROBLEM_JSON).json(
          problemDetail(400, 'Bad Request', 'path query parameter is required')
        );
        return;
      }

      const content = await readFile(pathParam);
      res.type('text/plain').send(content);
    } catch (err) {
      next(err);
    }
  });

  // --- Put file (write) ---
  router.put('/project/file', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (writeLock.isHeld()) {
        logger.warn({ path: req.path }, 'Write rejected: agent lock active');
        res.status(409).contentType(PROBLEM_JSON).json(
          problemDetail(409, 'Agent Active', 'Write operations are locked while the agent is active. Please wait for the agent to complete.')
        );
        return;
      }

      const pathParam = req.query.path as string;
      if (!pathParam) {
        res.status(400).contentType(PROBLEM_JSON).json(
          problemDetail(400, 'Bad Request', 'path query parameter is required')
        );
        return;
      }

      const content = typeof req.body === 'string' ? req.body : req.body?.content ?? '';
      await writeFile(pathParam, content);
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // --- Delete file ---
  router.delete('/project/file', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (writeLock.isHeld()) {
        logger.warn({ path: req.path }, 'Delete rejected: agent lock active');
        res.status(409).contentType(PROBLEM_JSON).json(
          problemDetail(409, 'Agent Active', 'Write operations are locked while the agent is active. Please wait for the agent to complete.')
        );
        return;
      }

      const pathParam = req.query.path as string;
      if (!pathParam) {
        res.status(400).contentType(PROBLEM_JSON).json(
          problemDetail(400, 'Bad Request', 'path query parameter is required')
        );
        return;
      }

      await deleteFile(pathParam);
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // --- SSE events ---
  router.get('/project/events', (req: Request, res: Response, _next: NextFunction) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const watcher = createProjectWatcher((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.on('close', () => {
      watcher.close();
    });

    logger.info({ path: req.path }, 'SSE client connected');
  });

  // --- Internal lock API ---
  router.post('/internal/lock', (_req: Request, res: Response) => {
    const lockId = writeLock.acquire();
    if (lockId) {
      res.status(200).json({ lockId });
    } else {
      res.status(409).contentType(PROBLEM_JSON).json(
        problemDetail(409, 'Lock Held', 'Write lock is already held by another process')
      );
    }
  });

  router.patch('/internal/lock', (req: Request, res: Response) => {
    const lockId = req.body?.lockId as string;
    if (!lockId) {
      res.status(400).contentType(PROBLEM_JSON).json(
        problemDetail(400, 'Bad Request', 'lockId is required in request body')
      );
      return;
    }
    const renewed = writeLock.renew(lockId);
    if (renewed) {
      res.status(200).json({ ok: true });
    } else {
      res.status(404).contentType(PROBLEM_JSON).json(
        problemDetail(404, 'Lock Not Found', 'No matching lock found to renew')
      );
    }
  });

  router.delete('/internal/lock', (req: Request, res: Response) => {
    const lockId = req.body?.lockId as string;
    if (!lockId) {
      res.status(400).contentType(PROBLEM_JSON).json(
        problemDetail(400, 'Bad Request', 'lockId is required in request body')
      );
      return;
    }
    const released = writeLock.release(lockId);
    if (released) {
      res.status(200).json({ ok: true });
    } else {
      res.status(404).contentType(PROBLEM_JSON).json(
        problemDetail(404, 'Lock Not Found', 'No matching lock found to release')
      );
    }
  });

  return router;
}
