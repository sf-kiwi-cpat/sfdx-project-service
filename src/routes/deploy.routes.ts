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
import { DeploymentError, DeploymentNotFoundError } from '../errors.js';
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
      sse: true,
      // Resource-existence checks run in `preHandler` so they happen *before*
      // `@fastify/sse`'s route wrapper takes over. When the wrapper sees
      // `Accept: text/event-stream` it commits 200 text/event-stream headers
      // around the handler body, which means a throw / reply.status(404) from
      // inside the handler can no longer be rewritten to 404 problem+json —
      // the browser just sees an empty 200 stream. See issue #206. Also
      // satisfies the contract-pinned ordering: missing-project /
      // missing-deployment → 404 takes precedence over missing-Accept → 400.
      preHandler: async (request) => {
        const { id, deploymentId } = request.params as { id: string; deploymentId: string };
        await getProjectDir(id);
        if (!deploymentExists(deploymentId)) {
          throw new DeploymentNotFoundError(deploymentId);
        }
      },
    },
    async (request, reply) => {
      const { deploymentId } = request.params as { id: string; deploymentId: string };

      // Strict SSE content negotiation: without `Accept: text/event-stream`,
      // the `@fastify/sse` plugin falls back to our handler without
      // installing `reply.sse`, which would crash into a 500 TypeError.
      // Reject explicitly with 400 problem+json instead. Real browser
      // EventSource always sends this header automatically.
      const accept = request.headers.accept ?? '';
      if (accept !== 'text/event-stream') {
        return reply
          .status(400)
          .type(PROBLEM_JSON)
          .send(problemDetail(400, 'Bad Request', 'SSE requires Accept: text/event-stream'));
      }

      reply.sse.keepAlive();
      await reply.sse.send({ event: 'start', data: { deploymentId } });

      let lastEventCount = 0;

      // Belt-and-suspenders: the `onClose` callback below should stop the
      // poll when the client disconnects, but if it races against an
      // in-flight tick, this guard catches it too.
      const pollInterval = setInterval(() => {
        if (!reply.sse.isConnected) {
          clearInterval(pollInterval);
          return;
        }

        const events = getProgressEvents(deploymentId);
        for (let i = lastEventCount; i < events.length; i++) {
          /* v8 ignore next 2 -- timing-dependent: only hit when poll catches new events */
          reply.sse.send({ event: 'progress', data: events[i] }).catch(() => {
            /* client went away; `isConnected` will be false next tick */
          });
        }
        lastEventCount = events.length;

        const result = getDeploymentResult(deploymentId);
        if (result) {
          clearInterval(pollInterval);
          // Close on both fulfillment and rejection: a send-error still
          // needs the stream torn down, and `close()` is idempotent.
          reply.sse.send({ event: 'complete', data: result }).then(
            () => reply.sse.close(),
            () => reply.sse.close()
          );
        }
      }, 100);

      reply.sse.onClose(() => clearInterval(pollInterval));
    }
  );
}
