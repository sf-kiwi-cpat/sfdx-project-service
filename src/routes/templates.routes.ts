import express, { Request, Response, NextFunction } from 'express';
import { listTemplates } from '../domain/templates.js';

export function createTemplatesRouter(): express.Router {
  const router = express.Router();

  /**
   * @openapi
   * /templates:
   *   get:
   *     summary: List available project templates
   *     description: Returns an array of available project templates.
   *     responses:
   *       '200':
   *         description: List of templates
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   id:
   *                     type: string
   *                   name:
   *                     type: string
   *                 required: [id, name]
   */
  router.get('/templates', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const templates = await listTemplates();
      res.json(templates);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
