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
  getDeploymentStageEvents,
  getDeploymentWarningEvents,
} from '../deployments.js';

const ProjectParams = Type.Object({ id: Type.String() });
const DeploymentParams = Type.Object({ id: Type.String(), deploymentId: Type.String() });
const DeploymentBody = Type.Object({
  orgAlias: Type.Optional(Type.String()),
});

export async function deployRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/projects/:id/deployments',
    {
      schema: {
        params: ProjectParams,
        body: DeploymentBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { orgAlias?: string };

      // Get project directory
      const projectDir = await getProjectDir(id);

      // Zero-auth contract: auth is resolved server-side in the priority
      // order body.orgAlias → project target-org → global default.
      // Caller-supplied Authorization / X-Salesforce-Instance-Url headers
      // are intentionally ignored — they are not part of the contract.
      const auth = await resolveDeployAuth(projectDir, body.orgAlias);

      if (auth.type === 'missing') {
        return reply
          .status(400)
          .type(PROBLEM_JSON)
          .send(
            problemDetail(
              400,
              'Bad Request',
              'No authentication available. Supply an `orgAlias` in the request body, set the project target-org at project creation, or configure a global default org (`sf config set target-org <alias>`).'
            )
          );
      }

      if (auth.type === 'unresolved-alias') {
        return reply
          .status(400)
          .type(PROBLEM_JSON)
          .send(
            problemDetail(
              400,
              'Bad Request',
              `orgAlias '${auth.alias}' does not resolve to a Salesforce username. Run \`sf org login web --alias ${auth.alias}\` or use a different alias.`
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

      // Replay any history recorded before this GET opened (reconnect-safe
      // by design — tests poll by re-opening the stream). `lastXCount`
      // prevents the subsequent poll loop from re-sending the same ones.
      const replayedStages = getDeploymentStageEvents(deploymentId);
      for (const stage of replayedStages) {
        await reply.sse.send({ event: 'stage', data: stage });
      }
      let lastStageCount = replayedStages.length;

      const replayedProgress = getProgressEvents(deploymentId);
      for (const p of replayedProgress) {
        await reply.sse.send({ event: 'progress', data: p });
      }
      let lastProgressCount = replayedProgress.length;

      const replayedWarnings = getDeploymentWarningEvents(deploymentId);
      for (const w of replayedWarnings) {
        await reply.sse.send({ event: 'warning', data: w });
      }
      let lastWarningCount = replayedWarnings.length;

      // If the deploy finished before this GET arrived, send `complete`
      // immediately and close. This is the common path for tests that
      // poll-until-complete.
      const earlyResult = getDeploymentResult(deploymentId);
      if (earlyResult) {
        await reply.sse.send({ event: 'complete', data: earlyResult });
        reply.sse.close();
        return;
      }

      // Belt-and-suspenders: the `onClose` callback below should stop the
      // poll when the client disconnects, but if it races against an
      // in-flight tick, this guard catches it too.
      const pollInterval = setInterval(() => {
        if (!reply.sse.isConnected) {
          clearInterval(pollInterval);
          return;
        }

        const stages = getDeploymentStageEvents(deploymentId);
        for (let i = lastStageCount; i < stages.length; i++) {
          /* v8 ignore next 2 -- timing-dependent: only hit when poll catches new stage events */
          reply.sse.send({ event: 'stage', data: stages[i] }).catch(() => {});
        }
        lastStageCount = stages.length;

        const events = getProgressEvents(deploymentId);
        for (let i = lastProgressCount; i < events.length; i++) {
          /* v8 ignore next 2 -- timing-dependent: only hit when poll catches new events */
          reply.sse.send({ event: 'progress', data: events[i] }).catch(() => {
            /* client went away; `isConnected` will be false next tick */
          });
        }
        lastProgressCount = events.length;

        const warns = getDeploymentWarningEvents(deploymentId);
        for (let i = lastWarningCount; i < warns.length; i++) {
          /* v8 ignore next 2 -- timing-dependent: only hit when poll catches new warnings */
          reply.sse.send({ event: 'warning', data: warns[i] }).catch(() => {});
        }
        lastWarningCount = warns.length;

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
