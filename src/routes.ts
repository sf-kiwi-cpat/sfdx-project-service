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
import { deployMetadata, type OrgCredentials } from './deploy.js';
import { buildTree } from './files.js';
import { listTemplates } from './templates.js';
import { createProject, getProjectDir } from './projects.js';

export function createRouter(): express.Router {
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

  /**
   * @openapi
   * /projects/{id}/deploy:
   *   post:
   *     summary: Deploy project metadata to a Salesforce org
   *     description: Reads metadata paths from the project's sfdx-project.json and deploys to the given Salesforce org using SDR.
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *         description: Project UUID
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
   *       '200':
   *         description: Deployment succeeded
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 ok:
   *                   type: boolean
   *                 status:
   *                   type: string
   *                 numberComponentsDeployed:
   *                   type: integer
   *                 numberComponentsTotal:
   *                   type: integer
   *                 components:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       fullName:
   *                         type: string
   *                       type:
   *                         type: string
   *                       state:
   *                         type: string
   *       '400':
   *         description: Missing credentials
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   *       '404':
   *         description: Project not found
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   *       '502':
   *         description: Deployment failed
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   */
  router.post('/projects/:id/deploy', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { accessToken, instanceUrl } = req.body as Partial<OrgCredentials>;

      if (!accessToken || !instanceUrl) {
        res
          .status(400)
          .contentType(PROBLEM_JSON)
          .json(
            problemDetail(
              400,
              'Bad Request',
              'accessToken and instanceUrl are required in the request body'
            )
          );
        return;
      }

      const projectDir = await getProjectDir(req.params.id);
      const result = await deployMetadata(projectDir, { accessToken, instanceUrl });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
