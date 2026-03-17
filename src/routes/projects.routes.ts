import express, { Request, Response, NextFunction } from 'express';
import { problemDetail, PROBLEM_JSON } from '../errors.js';
import { buildTree } from '../files.js';
import { createProject, getProjectDir } from '../projects.js';

export function createProjectsRouter(): express.Router {
  const router = express.Router();

  /**
   * @openapi
   * /projects:
   *   post:
   *     summary: Create a new project from a template
   *     description: Creates a new project by unzipping a template into a UUID-named directory.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [template]
   *             properties:
   *               template:
   *                 type: string
   *                 description: Template ID (filename without .zip extension)
   *     responses:
   *       '201':
   *         description: Project created
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 id:
   *                   type: string
   *                   format: uuid
   *       '400':
   *         description: Missing or invalid template
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   */
  router.post('/projects', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { template } = req.body as { template?: string };
      if (!template) {
        res
          .status(400)
          .contentType(PROBLEM_JSON)
          .json(problemDetail(400, 'Bad Request', 'template is required in request body'));
        return;
      }

      const id = await createProject(template);
      res.status(201).json({ id });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /projects/{id}/tree:
   *   get:
   *     summary: Get the file tree for a project
   *     description: Returns a recursive tree structure of the project files.
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *         description: Project UUID
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
  router.get('/projects/:id/tree', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectDir = await getProjectDir(req.params.id);
      const tree = await buildTree(undefined, projectDir);
      res.json(tree);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
