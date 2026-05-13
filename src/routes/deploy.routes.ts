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
import { problemDetail, problemJsonResponse, PROBLEM_JSON } from '../errors.js';
import { deployMetadataAsync, buildConnectionFromAuth } from '../domain/deploy.js';
import { DeploymentError, DeploymentNotFoundError } from '../errors.js';
import { getProjectDir } from '../domain/projects.js';
import { resolveDeployAuth } from '../domain/deploy-auth.js';
import {
  createDeployment,
  deploymentExists,
  getDeploymentResult,
  setDeploymentPollPromise,
  getProgressEvents,
  getDeploymentStageEvents,
  getDeploymentWarningEvents,
} from '../deployments.js';

const ProjectParams = Type.Object({
  id: Type.String({ description: 'Project identifier returned by create/list endpoints.' }),
});
const DeploymentParams = Type.Object({
  id: Type.String({ description: 'Project identifier returned by create/list endpoints.' }),
  deploymentId: Type.String({
    description: 'Deployment identifier returned by `POST /v1/projects/{id}/deployments`.',
  }),
});

const DeploymentBody = Type.Object({
  // `minLength: 1` rejects explicit empty-string aliases with a 400 at
  // the schema layer. Without it, `resolveDeployAuth` would silently
  // fall through to env/project/global — inconsistent with `POST
  // /v1/projects`, where an empty `orgAlias` throws
  // `OrgAliasEmptyError` (400). Mismatched behavior between the two
  // endpoints is a latent footgun for callers.
  orgAlias: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Optional Salesforce CLI org alias to deploy against. When omitted, ' +
        'auth resolves from the project `target-org` or the global default org.',
    })
  ),
});

export async function deployRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/projects/:id/deployments',
    {
      schema: {
        summary: 'Start an asynchronous metadata deployment',
        description:
          'Kicks off a metadata deployment to the authenticated Salesforce org ' +
          'and returns a deployment id to use with the SSE stream at ' +
          '`GET /v1/projects/{id}/deployments/{deploymentId}/events`. Auth is ' +
          'resolved server-side in priority order: (1) body `orgAlias`, ' +
          '(2) project `target-org`, (3) global default org. If none yield ' +
          'credentials, the request fails with 400.',
        tags: ['Deployments'],
        params: ProjectParams,
        body: DeploymentBody,
        response: {
          202: {
            description:
              'Deployment accepted. The returned `deploymentId` can be used to stream progress events.',
            ...Type.Object({
              deploymentId: Type.String({
                description: 'Unique identifier for the in-flight deployment.',
              }),
              status: Type.String({
                description: "Initial deployment status — always `'Queued'` on acceptance.",
              }),
            }),
          },
          400: problemJsonResponse(
            'No authentication is available — no `orgAlias` supplied, no project ' +
              'target-org set, and no global default org configured; or the supplied ' +
              '`orgAlias` does not resolve to a Salesforce username.'
          ),
          404: problemJsonResponse('No project exists with the supplied id.'),
          502: problemJsonResponse(
            'The Salesforce org rejected the connection or the deployment failed to start.'
          ),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { orgAlias?: string };

      // Get project directory
      const projectDir = await getProjectDir(id);

      // Zero-auth contract: auth is resolved server-side in the priority
      // order body.orgAlias → project target-org → global default.
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
        summary: 'Stream deployment progress as Server-Sent Events',
        description:
          'Subscribes to the deployment identified by `deploymentId`, emitting ' +
          'SSE `start`, `progress`, and `complete` events until the deployment ' +
          'reaches a terminal state and the stream closes.',
        tags: ['Deployments'],
        params: DeploymentParams,
        response: {
          200: {
            description: 'Server-Sent Events stream of deployment progress.',
            content: {
              'text/event-stream': {
                schema: {
                  type: 'string',
                  description:
                    'Server-Sent Events stream. Event types: `start`, `progress`, `complete`. ' +
                    'Each `data:` payload is a JSON-encoded deployment event.',
                },
              },
            },
          },
          400: problemJsonResponse(
            'The request did not include the `Accept: text/event-stream` header required for SSE.'
          ),
          404: problemJsonResponse(
            'Either the project or the supplied deployment id does not exist.'
          ),
        },
      },
      sse: true,
      // SSE ordering rule: validate before the stream is committed.
      // Resource-existence checks run in `preHandler` so they happen *before*
      // `@fastify/sse`'s route wrapper takes over. When the wrapper sees
      // `Accept: text/event-stream` it commits 200 text/event-stream headers
      // around the handler body, which means a throw / reply.status(404) from
      // inside the handler can no longer be rewritten to 404 problem+json —
      // the browser just sees an empty 200 stream. See issue #206. Also
      // satisfies the contract-pinned ordering: missing-project /
      // missing-deployment → 404 takes precedence over missing-Accept → 400.
      // (If this route ever switches to manual streaming via reply.hijack() +
      // reply.raw, the same rule applies: validate first, hijack second.
      // See src/CLAUDE.md "Fastify 5 gotchas".)
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

      // A rejected `reply.sse.send(...)` (e.g. broken pipe from an abrupt
      // client disconnect) is treated as a stream-terminal signal: the
      // poll interval is cleared and the SSE stream is closed from the
      // rejection handler. The `.catch` runs as a microtask, so any
      // `send` calls already issued on the same tick still fire — the
      // win is preventing the *next* poll tick from issuing more sends
      // into a doomed stream, instead of waiting for `onClose` or the
      // next-tick `isConnected` guard to catch up one or more ticks
      // later. Both of those remain in place as belt-and-suspenders.
      // `close()` and `clearInterval()` are both idempotent, so it is
      // safe if we race with `onClose` or another rejected send.
      const teardownOnSendFailure = (): void => {
        clearInterval(pollInterval);
        reply.sse.close();
      };

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
          reply.sse.send({ event: 'stage', data: stages[i] }).catch(teardownOnSendFailure);
        }
        lastStageCount = stages.length;

        const events = getProgressEvents(deploymentId);
        for (let i = lastProgressCount; i < events.length; i++) {
          /* v8 ignore next 2 -- timing-dependent: only hit when poll catches new events */
          reply.sse.send({ event: 'progress', data: events[i] }).catch(teardownOnSendFailure);
        }
        lastProgressCount = events.length;

        const warns = getDeploymentWarningEvents(deploymentId);
        for (let i = lastWarningCount; i < warns.length; i++) {
          /* v8 ignore next 2 -- timing-dependent: only hit when poll catches new warnings */
          reply.sse.send({ event: 'warning', data: warns[i] }).catch(teardownOnSendFailure);
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
