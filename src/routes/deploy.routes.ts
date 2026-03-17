import express, { Request, Response, NextFunction } from 'express';
import { problemDetail, PROBLEM_JSON } from '../errors.js';
import { deployMetadata, type OrgCredentials } from '../domain/deploy.js';
import { getProjectDir } from '../domain/projects.js';

export function createDeployRouter(): express.Router {
  const router = express.Router();

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
