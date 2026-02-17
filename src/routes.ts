import express, { Request, Response, NextFunction } from 'express';
import { problemDetail, PROBLEM_JSON, OAuthError } from './errors.js';
import { buildTree, readFile, writeFile, deleteFile } from './files.js';
import { logger } from './logger.js';
import { scaffoldProject, connectOrg, type InitInput } from './project.js';
import { createProjectWatcher } from './events.js';
import { WriteLock } from './lock.js';
import {
  generateAuthorizationUrl,
  handleCallback,
  getSession,
  isAuthenticated,
  clearSession,
} from './oauth.js';
import { isOAuthConfigured } from './config.js';

export function createRouter(writeLock: WriteLock): express.Router {
  const router = express.Router();

  // --- OAuth endpoints ---
  router.get('/oauth/authorize', (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isOAuthConfigured()) {
        res.status(400).contentType(PROBLEM_JSON).json(
          problemDetail(400, 'OAuth Not Configured', 'SF_CLIENT_ID and SF_CLIENT_SECRET are required')
        );
        return;
      }

      const loginUrl = req.query.loginUrl as string | undefined;
      const authorizationUrl = generateAuthorizationUrl(loginUrl);

      res.status(200).json({ authorizationUrl });
    } catch (err) {
      next(err);
    }
  });

  router.get('/oauth/callback', async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const error = req.query.error as string | undefined;
      const errorDescription = req.query.error_description as string | undefined;

      if (error) {
        const errorMsg = `OAuth Error: ${error}${errorDescription ? ` - ${errorDescription}` : ''}`;
        res.status(200).type('text/html').send(`
          <html>
            <head><title>Authentication Failed</title></head>
            <body>
              <h1>Authentication Failed</h1>
              <p>${escapeHtml(errorMsg)}</p>
              <p>You can close this tab.</p>
            </body>
          </html>
        `);
        return;
      }

      const code = req.query.code as string | undefined;
      const state = req.query.state as string | undefined;

      if (!code || !state) {
        res.status(200).type('text/html').send(`
          <html>
            <head><title>Authentication Failed</title></head>
            <body>
              <h1>Authentication Failed</h1>
              <p>Missing code or state parameter.</p>
              <p>You can close this tab.</p>
            </body>
          </html>
        `);
        return;
      }

      if (writeLock.isHeld()) {
        res.status(200).type('text/html').send(`
          <html>
            <head><title>Authentication Failed</title></head>
            <body>
              <h1>Authentication Failed</h1>
              <p>Server is busy. Please try again later.</p>
              <p>You can close this tab.</p>
            </body>
          </html>
        `);
        return;
      }

      const loginUrl = req.query.loginUrl as string | undefined;
      const session = await handleCallback(code, state, loginUrl);

      // Auto-connect org after successful OAuth
      await scaffoldProject();
      await connectOrg({ accessToken: session.accessToken, instanceUrl: session.instanceUrl });

      res.status(200).type('text/html').send(`
        <html>
          <head><title>Authentication Successful</title></head>
          <body>
            <h1>Authentication successful</h1>
            <p>You can close this tab.</p>
          </body>
        </html>
      `);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(200).type('text/html').send(`
        <html>
          <head><title>Authentication Failed</title></head>
          <body>
            <h1>Authentication Failed</h1>
            <p>${escapeHtml(message)}</p>
            <p>You can close this tab.</p>
          </body>
        </html>
      `);
    }
  });

  router.get('/oauth/status', (_req: Request, res: Response) => {
    const session = getSession();
    const auth = isAuthenticated();

    res.status(200).json({
      authenticated: auth,
      ...(auth && session ? {
        instanceUrl: session.instanceUrl,
        orgId: session.orgId,
        orgName: session.orgName,
        userId: session.userId,
      } : {}),
    });
  });

  router.post('/oauth/disconnect', (_req: Request, res: Response) => {
    clearSession();
    res.status(204).send();
  });

  // --- Project init ---
  router.post('/project/init', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (writeLock.isHeld()) {
        logger.warn({ path: req.path }, 'Init rejected: agent lock active');
        res.status(409).contentType(PROBLEM_JSON).json(
          problemDetail(409, 'Agent Active', 'Write operations are locked while the agent is active. Please wait for the agent to complete.')
        );
        return;
      }

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

/**
 * Escape HTML special characters to prevent XSS in error messages.
 */
function escapeHtml(text: string): string {
  const map: { [key: string]: string } = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char] || char);
}
