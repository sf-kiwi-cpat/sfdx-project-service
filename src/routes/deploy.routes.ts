import { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { problemDetail, PROBLEM_JSON } from '../errors.js';
import { extractCredentials } from '../utils/auth.js';
import { deployMetadataAsync, buildConnection } from '../domain/deploy.js';
import { DeploymentError } from '../errors.js';
import { getProjectDir } from '../domain/projects.js';
import {
  createDeployment,
  deploymentExists,
  getDeploymentResult,
  setDeploymentPollPromise,
  getProgressEvents,
} from '../deployments.js';

const ProjectParams = Type.Object({ id: Type.String() });
const DeploymentParams = Type.Object({ id: Type.String(), deploymentId: Type.String() });

export async function deployRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/projects/:id/deployments',
    {
      schema: {
        params: ProjectParams,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      // Extract and validate credentials from headers
      const credentialsResult = extractCredentials(request);
      if (!credentialsResult.valid) {
        return reply
          .status(400)
          .type(PROBLEM_JSON)
          .send(problemDetail(400, 'Bad Request', credentialsResult.error));
      }

      const credentials = credentialsResult.credentials;

      // Get project directory
      const projectDir = await getProjectDir(id);

      // Eagerly validate the connection to catch auth errors early
      try {
        await buildConnection(credentials);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Connection failed';
        throw new DeploymentError(msg);
      }

      // Create deployment record
      const deploymentId = createDeployment(id);

      // Start async deployment in background
      const deploymentPromise = deployMetadataAsync(deploymentId, projectDir, credentials);

      // Store the promise to prevent concurrent polls
      setDeploymentPollPromise(deploymentId, deploymentPromise);

      // Return 202 Accepted immediately
      return reply.status(202).send({
        deploymentId,
        status: 'Queued',
      });
    }
  );

  app.get(
    '/projects/:id/deployments/:deploymentId',
    {
      schema: {
        params: DeploymentParams,
      },
    },
    async (request, reply) => {
      const { id, deploymentId } = request.params as { id: string; deploymentId: string };

      // Verify project exists
      await getProjectDir(id);

      // Check if deployment exists
      if (!deploymentExists(deploymentId)) {
        return reply
          .status(404)
          .type(PROBLEM_JSON)
          .send(problemDetail(404, 'Deployment Not Found', `Deployment ${deploymentId} not found`));
      }

      // Get deployment result (don't wait - polling should return current state)
      const result = getDeploymentResult(deploymentId);
      if (!result) {
        // Deployment still in progress
        return reply.status(200).send({
          deploymentId,
          status: 'InProgress',
        });
      }

      return reply.status(200).send(result);
    }
  );

  app.get(
    '/projects/:id/deployments/:deploymentId/events',
    {
      schema: {
        params: DeploymentParams,
      },
    },
    async (request, reply) => {
      const { id, deploymentId } = request.params as { id: string; deploymentId: string };

      // Verify project exists (can throw ProjectNotFoundError → caught by error handler)
      await getProjectDir(id);

      // Check if deployment exists
      if (!deploymentExists(deploymentId)) {
        return reply
          .status(404)
          .type(PROBLEM_JSON)
          .send(problemDetail(404, 'Deployment Not Found', `Deployment ${deploymentId} not found`));
      }

      // Hijack the response for SSE streaming
      reply.hijack();

      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Send start event
      raw.write('event: start\n');
      raw.write(`data: {"deploymentId":"${deploymentId}"}\n\n`);

      let lastEventCount = 0;

      // Poll for deployment result and stream events
      const pollInterval = setInterval(() => {
        // Stream any new progress events
        const events = getProgressEvents(deploymentId);
        for (let i = lastEventCount; i < events.length; i++) {
          raw.write('event: progress\n');
          raw.write(`data: ${JSON.stringify(events[i])}\n\n`);
        }
        lastEventCount = events.length;

        // Check if deployment is complete
        const result = getDeploymentResult(deploymentId);
        if (result) {
          // Deployment is complete
          clearInterval(pollInterval);

          // Send result event
          raw.write('event: complete\n');
          raw.write(`data: ${JSON.stringify(result)}\n\n`);

          // Close the stream
          raw.end();
        }
      }, 100);

      // Handle client disconnect
      request.raw.on('close', () => {
        clearInterval(pollInterval);
      });
    }
  );
}
