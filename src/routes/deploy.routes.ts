/*
 * Copyright (c) 2026, Salesforce, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { problemDetail, PROBLEM_JSON } from '../errors.js';
import { extractOptionalCredentials } from '../utils/auth.js';
import { deployMetadataAsync, buildConnectionFromAuth } from '../domain/deploy.js';
import { DeploymentError } from '../errors.js';
import { getProjectDir } from '../domain/projects.js';
import { resolveDeployAuth } from '../domain/auth.js';
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

      // Get project directory
      const projectDir = await getProjectDir(id);

      // Extract optional credential headers (for legacy fallback)
      const headerCredentials = extractOptionalCredentials(request);

      // Resolve auth using priority chain:
      // 1. Project target-org  2. Global default org  3. Credential headers  4. 400
      const auth = await resolveDeployAuth(projectDir, headerCredentials ?? undefined);

      if (!auth) {
        return reply
          .status(400)
          .type(PROBLEM_JSON)
          .send(
            problemDetail(
              400,
              'Bad Request',
              'No authentication available. Provide orgAlias at project creation, configure a global default org, or pass Authorization and X-Salesforce-Instance-Url headers.'
            )
          );
      }

      // Eagerly validate the connection to catch auth errors early
      try {
        await buildConnectionFromAuth(auth);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Connection failed';
        throw new DeploymentError(msg);
      }

      // Create deployment record
      const deploymentId = createDeployment(id);

      // Start async deployment in background
      const deploymentPromise = deployMetadataAsync(deploymentId, projectDir, auth);

      // Store the promise for test observability
      setDeploymentPollPromise(deploymentId, deploymentPromise);

      // Return 202 Accepted immediately
      return reply.status(202).send({
        deploymentId,
        status: 'Queued',
      });
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
        'Access-Control-Allow-Origin': '*',
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
          /* v8 ignore next 2 -- timing-dependent: only hit when poll catches new events */
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
