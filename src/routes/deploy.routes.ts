import express, { Request, Response, NextFunction } from 'express';
import { problemDetail, PROBLEM_JSON } from '../errors.js';
import {
  validateCredentials,
  deployMetadataAsync,
  buildConnection,
  type OrgCredentials,
} from '../domain/deploy.js';
import { DeploymentError } from '../errors.js';
import { getProjectDir } from '../domain/projects.js';
import {
  createDeployment,
  deploymentExists,
  getDeploymentResult,
  setDeploymentPollPromise,
  getProgressEvents,
} from '../deployments.js';

export function createDeployRouter(): express.Router {
  const router = express.Router();

  /**
   * @openapi
   * /v1/projects/{id}/deployments:
   *   post:
   *     summary: Initiate async deployment of project metadata
   *     description: Starts a background deployment and returns immediately with a deployment ID for polling
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
   *       '202':
   *         description: Deployment accepted and started
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 deploymentId:
   *                   type: string
   *                 status:
   *                   type: string
   *       '400':
   *         description: Missing or invalid credentials
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
   *         description: Connection failed
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   */
  router.post(
    '/projects/:id/deployments',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { accessToken, instanceUrl } = req.body as Partial<OrgCredentials>;

        // Validate credentials
        const validation = validateCredentials(accessToken, instanceUrl);
        if (!validation.valid) {
          res
            .status(400)
            .contentType(PROBLEM_JSON)
            .json(problemDetail(400, 'Bad Request', validation.error));
          return;
        }

        // Get project directory
        const projectDir = await getProjectDir(req.params.id);

        // Eagerly validate the connection to catch auth errors early
        const credentials: OrgCredentials = {
          accessToken: accessToken!,
          instanceUrl: instanceUrl!,
        };
        try {
          await buildConnection(credentials);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Connection failed';
          throw new DeploymentError(msg);
        }

        // Create deployment record
        const deploymentId = createDeployment(req.params.id);

        // Start async deployment in background
        const deploymentPromise = deployMetadataAsync(deploymentId, projectDir, credentials);

        // Store the promise to prevent concurrent polls
        setDeploymentPollPromise(deploymentId, deploymentPromise);

        // Return 202 Accepted immediately
        res.status(202).json({
          deploymentId,
          status: 'Queued',
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * @openapi
   * /v1/projects/{id}/deployments/{deploymentId}:
   *   get:
   *     summary: Get deployment status
   *     description: Polls the status of a deployment
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *         description: Project UUID
   *       - in: path
   *         name: deploymentId
   *         required: true
   *         schema:
   *           type: string
   *         description: Deployment ID (deploy_*)
   *     responses:
   *       '200':
   *         description: Deployment status
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 deploymentId:
   *                   type: string
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
   *       '404':
   *         description: Project or deployment not found
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   */
  router.get(
    '/projects/:id/deployments/:deploymentId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Verify project exists
        await getProjectDir(req.params.id);

        // Check if deployment exists
        if (!deploymentExists(req.params.deploymentId)) {
          res
            .status(404)
            .contentType(PROBLEM_JSON)
            .json(
              problemDetail(
                404,
                'Deployment Not Found',
                `Deployment ${req.params.deploymentId} not found`
              )
            );
          return;
        }

        // Get deployment result (don't wait - polling should return current state)
        const result = getDeploymentResult(req.params.deploymentId);
        if (!result) {
          // Deployment still in progress
          res.status(200).json({
            deploymentId: req.params.deploymentId,
            status: 'InProgress',
          });
          return;
        }

        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * @openapi
   * /v1/projects/{id}/deployments/{deploymentId}/events:
   *   get:
   *     summary: Stream deployment events
   *     description: Returns a Server-Sent Events stream of deployment progress
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *         description: Project UUID
   *       - in: path
   *         name: deploymentId
   *         required: true
   *         schema:
   *           type: string
   *         description: Deployment ID (deploy_*)
   *     responses:
   *       '200':
   *         description: Server-Sent Events stream
   *         content:
   *           text/event-stream:
   *             schema:
   *               type: string
   *       '404':
   *         description: Project or deployment not found
   *         content:
   *           application/problem+json:
   *             schema:
   *               $ref: '#/components/schemas/ProblemDetail'
   */
  router.get(
    '/projects/:id/deployments/:deploymentId/events',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Verify project exists
        await getProjectDir(req.params.id);

        // Check if deployment exists
        if (!deploymentExists(req.params.deploymentId)) {
          res
            .status(404)
            .contentType(PROBLEM_JSON)
            .json(
              problemDetail(
                404,
                'Deployment Not Found',
                `Deployment ${req.params.deploymentId} not found`
              )
            );
          return;
        }

        // Set up SSE response headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        // Send start event
        res.write('event: start\n');
        res.write(`data: {"deploymentId":"${req.params.deploymentId}"}\n\n`);

        let lastEventCount = 0;

        // Poll for deployment result and stream events
        const pollInterval = setInterval(() => {
          // Stream any new progress events
          const events = getProgressEvents(req.params.deploymentId);
          for (let i = lastEventCount; i < events.length; i++) {
            res.write('event: progress\n');
            res.write(`data: ${JSON.stringify(events[i])}\n\n`);
          }
          lastEventCount = events.length;

          // Check if deployment is complete
          const result = getDeploymentResult(req.params.deploymentId);
          if (result) {
            // Deployment is complete
            clearInterval(pollInterval);

            // Send result event
            res.write('event: complete\n');
            res.write(`data: ${JSON.stringify(result)}\n\n`);

            // Close the stream
            res.end();
          }
        }, 100);

        // Handle client disconnect
        req.on('close', () => {
          clearInterval(pollInterval);
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
