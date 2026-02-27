/**
 * @openapi
 * components:
 *   schemas:
 *     ProblemDetail:
 *       type: object
 *       description: RFC 9457 Problem Details
 *       properties:
 *         status:
 *           type: integer
 *         title:
 *           type: string
 *         detail:
 *           type: string
 *         type:
 *           type: string
 *         instance:
 *           type: string
 *       required: [status, title, detail]
 *     TreeNode:
 *       type: object
 *       description: Recursive file-tree node
 *       properties:
 *         name:
 *           type: string
 *         type:
 *           type: string
 *           enum: [file, directory]
 *         children:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/TreeNode'
 *       required: [name, type]
 */
import express, { Request, Response, NextFunction } from 'express';
import { problemDetail, PROBLEM_JSON } from './errors.js';
import { buildTree, readFile, writeFile, deleteFile } from './files.js';
import { logger } from './logger.js';
import { scaffoldProject, connectOrg, type InitInput } from './project.js';
import { createProjectWatcher } from './events.js';
import { WriteLock } from './lock.js';

/**
 * Express middleware that rejects requests with 409 if the write lock is held.
 * Applies to write operations (POST, PUT, DELETE) that should not run while
 * the agent is active.
 */
function requireWriteUnlocked(writeLock: WriteLock) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (writeLock.isHeld()) {
      logger.warn({ path: req.path }, 'Write rejected: agent lock active');
      res.status(409).contentType(PROBLEM_JSON).json(
        problemDetail(409, 'Agent Active', 'Write operations are locked while the agent is active. Please wait for the agent to complete.')
      );
      return;
    }
    next();
  };
}

export function createRouter(writeLock: WriteLock): express.Router {
  const router = express.Router();

  /**
   * @openapi
   * /project/init:
   *   post:
   *     summary: Initialize a Salesforce project
   *     description: Scaffolds a new SFDX project and connects it to the given org.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [accessToken, instanceUrl]
   *             properties:
   *               accessToken:
   *                 type: string
   *                 description: OAuth access token for the Salesforce org
   *               instanceUrl:
   *                 type: string
   *                 format: uri
   *                 description: Salesforce instance URL
   *     responses:
   *       '201':
   *         description: Project scaffolded and org connected
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 ok:
   *                   type: boolean
   *                 message:
   *                   type: string
   *       '400':
   *         description: Missing or invalid parameters
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   *       '409':
   *         description: Write lock is held
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   */
  router.post('/project/init', requireWriteUnlocked(writeLock), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { accessToken, instanceUrl } = req.body as InitInput;
      if (!accessToken || !instanceUrl) {
        res.status(400).contentType(PROBLEM_JSON).json(
          problemDetail(400, 'Bad Request', 'accessToken and instanceUrl are required')
        );
        return;
      }

      try {
        new URL(instanceUrl);
      } catch {
        res.status(400).contentType(PROBLEM_JSON).json(
          problemDetail(400, 'Bad Request', 'instanceUrl must be a valid URL')
        );
        return;
      }

      await scaffoldProject();
      await connectOrg({ accessToken, instanceUrl });

      res.status(201).json({ ok: true, message: 'Project scaffolded and org connected' });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /project/tree:
   *   get:
   *     summary: Get the project file tree
   *     description: Returns a recursive tree structure of the project files.
   *     responses:
   *       '200':
   *         description: File tree
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/TreeNode'
   *       '404':
   *         description: Project not found
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   */
  router.get('/project/tree', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const tree = await buildTree();
      res.json(tree);
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /project/file:
   *   get:
   *     summary: Read a project file
   *     description: Returns the content of a file at the given path as plain text.
   *     parameters:
   *       - in: query
   *         name: path
   *         required: true
   *         schema:
   *           type: string
   *         description: Relative path to the file within the project
   *     responses:
   *       '200':
   *         description: File content
   *         content:
   *           text/plain:
   *             schema:
   *               type: string
   *       '400':
   *         description: Missing or invalid path
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   *       '404':
   *         description: File not found
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   */
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

  /**
   * @openapi
   * /project/file:
   *   put:
   *     summary: Write a project file
   *     description: Creates or overwrites a file at the given path. Accepts text/plain body or JSON with a content field.
   *     parameters:
   *       - in: query
   *         name: path
   *         required: true
   *         schema:
   *           type: string
   *         description: Relative path to the file within the project
   *     requestBody:
   *       required: true
   *       content:
   *         text/plain:
   *           schema:
   *             type: string
   *         application/json:
   *           schema:
   *             type: object
   *             required: [content]
   *             properties:
   *               content:
   *                 type: string
   *     responses:
   *       '200':
   *         description: File written
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 ok:
   *                   type: boolean
   *       '400':
   *         description: Missing or invalid path or body
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   *       '409':
   *         description: Write lock is held
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   */
  router.put('/project/file', requireWriteUnlocked(writeLock), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pathParam = req.query.path as string;
      if (!pathParam) {
        res.status(400).contentType(PROBLEM_JSON).json(
          problemDetail(400, 'Bad Request', 'path query parameter is required')
        );
        return;
      }

      const content = typeof req.body === 'string' ? req.body : req.body?.content;
      if (content === undefined || content === null) {
        res.status(400).contentType(PROBLEM_JSON).json(
          problemDetail(400, 'Bad Request', 'Request body must be text/plain, application/json with content field, or application/octet-stream')
        );
        return;
      }

      await writeFile(pathParam, String(content));
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /project/file:
   *   delete:
   *     summary: Delete a project file
   *     description: Deletes the file at the given path.
   *     parameters:
   *       - in: query
   *         name: path
   *         required: true
   *         schema:
   *           type: string
   *         description: Relative path to the file within the project
   *     responses:
   *       '200':
   *         description: File deleted
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 ok:
   *                   type: boolean
   *       '400':
   *         description: Missing or invalid path
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   *       '404':
   *         description: File not found
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   *       '409':
   *         description: Write lock is held
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   */
  router.delete('/project/file', requireWriteUnlocked(writeLock), async (req: Request, res: Response, next: NextFunction) => {
    try {
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

  /**
   * @openapi
   * /project/events:
   *   get:
   *     summary: Subscribe to project file events
   *     description: Opens a Server-Sent Events stream that emits file-change events.
   *     responses:
   *       '200':
   *         description: SSE event stream
   *         content:
   *           text/event-stream:
   *             schema:
   *               type: string
   */
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

  /**
   * @openapi
   * /internal/lock:
   *   post:
   *     summary: Acquire the write lock
   *     description: Acquires an exclusive write lock. Returns a lockId used to renew or release.
   *     responses:
   *       '200':
   *         description: Lock acquired
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 lockId:
   *                   type: string
   *       '409':
   *         description: Lock already held
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   */
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

  /**
   * @openapi
   * /internal/lock:
   *   patch:
   *     summary: Renew the write lock
   *     description: Extends the TTL of an existing write lock.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [lockId]
   *             properties:
   *               lockId:
   *                 type: string
   *     responses:
   *       '200':
   *         description: Lock renewed
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 ok:
   *                   type: boolean
   *       '400':
   *         description: Missing lockId
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   *       '404':
   *         description: Lock not found
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   */
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

  /**
   * @openapi
   * /internal/lock:
   *   delete:
   *     summary: Release the write lock
   *     description: Releases an existing write lock.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [lockId]
   *             properties:
   *               lockId:
   *                 type: string
   *     responses:
   *       '200':
   *         description: Lock released
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 ok:
   *                   type: boolean
   *       '400':
   *         description: Missing lockId
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   *       '404':
   *         description: Lock not found
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   */
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
