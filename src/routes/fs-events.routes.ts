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
import { getProjectDir } from '../domain/projects.js';
import { watcherManager, type FileEvent } from '../domain/watcher.js';
import { problemJsonResponse } from '../errors.js';

const ProjectParams = Type.Object({
  id: Type.String({ description: 'Project identifier returned by create/list endpoints.' }),
});

/** Map from the internal `FileEvent.type` to the SSE `event:` name. */
function sseEventName(type: FileEvent['type']): string {
  switch (type) {
    case 'add':
      return 'file-added';
    case 'change':
      return 'file-changed';
    case 'unlink':
      return 'file-removed';
  }
}

export async function fsEventRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/projects/:id/fs/events',
    {
      schema: {
        summary: 'Stream project filesystem change events',
        description:
          'Subscribes to add, change, and unlink events for the project tree ' +
          'over Server-Sent Events. Emits a `connected` event on subscription, ' +
          'then `file-added`, `file-changed`, and `file-removed` events as ' +
          'chokidar reports them. Heartbeat comments (`:heartbeat`) are sent ' +
          'every 15s to keep proxies from closing idle connections.',
        tags: ['Filesystem events'],
        params: ProjectParams,
        response: {
          200: {
            description: 'Server-Sent Events stream of filesystem change events.',
            content: {
              'text/event-stream': {
                schema: {
                  type: 'string',
                  description:
                    'Server-Sent Events stream. Event types: `connected`, ' +
                    '`file-added`, `file-changed`, `file-removed`. Each `data:` ' +
                    'payload is JSON; heartbeat lines are SSE comments.',
                },
              },
            },
          },
          400: problemJsonResponse(
            'The request did not include the `Accept: text/event-stream` header required for SSE.'
          ),
          404: problemJsonResponse('No project exists with the supplied id.'),
        },
      },
      sse: true,
      // Resource-existence check runs in `preHandler` so it happens *before*
      // `@fastify/sse`'s route wrapper takes over. When the wrapper sees
      // `Accept: text/event-stream` it commits 200 text/event-stream headers
      // around the handler body, which means a throw from `getProjectDir`
      // inside the handler can no longer be rewritten to 404 problem+json by
      // the error handler — the browser just sees an empty 200 stream. See
      // issue #206. Also satisfies the contract-pinned ordering:
      // missing-project → 404 takes precedence over missing-Accept → 400.
      preHandler: async (request) => {
        const { id } = request.params as { id: string };
        // Stash the resolved dir on the request so the handler can reuse it
        // without a second stat. Cast through `unknown` because Fastify's
        // request type is locked by the project's type provider.
        (request as unknown as { projectDir: string }).projectDir = await getProjectDir(id);
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const projectDir = (request as unknown as { projectDir: string }).projectDir;

      // Strict SSE content negotiation: without `Accept: text/event-stream`,
      // the `@fastify/sse` plugin falls back to our handler without
      // installing `reply.sse`, which would crash into a 500 TypeError.
      // Reject explicitly with 400 problem+json instead. Real browser
      // EventSource always sends this header automatically. Treat a
      // missing Accept header (`undefined`) the same as a wrong one.
      if (request.headers.accept !== 'text/event-stream') {
        return reply
          .status(400)
          .type(PROBLEM_JSON)
          .send(problemDetail(400, 'Bad Request', 'SSE requires Accept: text/event-stream'));
      }

      // The plugin installs its close handler in the SSEContext constructor
      // and drains `closeCallbacks` once on close. If the client disconnects
      // during the `await subscribe(...)` window below — which awaits
      // chokidar's initial scan + pre-ready buffer flush — a later
      // `reply.sse.onClose(unsubscribe)` would push into an already-empty
      // array and never fire, leaking the watcher subscription. Set a flag
      // via an early `onClose` so we can bail out ourselves.
      let closedDuringSubscribe = false;
      reply.sse.onClose(() => {
        closedDuringSubscribe = true;
      });

      // Subscribe first — awaits chokidar's initial scan (and pre-ready event
      // replay) so any write the client performs after `connected` can't be
      // misclassified as `add` when it was actually a `change`.
      // The `.catch` on `reply.sse.send` swallows the TOCTOU where the
      // connection closes between the chokidar event firing and the SSE
      // write reaching the socket. We previously also pre-checked
      // `reply.sse.isConnected`, but the `.catch` covers the same case
      // the pre-check did: a chokidar event whose handler runs against a
      // closed stream rejects, the `.catch` swallows it, and no event is
      // delivered. The pre-check was redundant.
      const unsubscribe = await watcherManager.subscribe(id, projectDir, (evt) => {
        reply.sse.send({ event: sseEventName(evt.type), data: evt }).catch(() => {
          /* client went away mid-send; plugin's own cleanup handles it */
        });
      });

      // `closedDuringSubscribe` covers the narrow window where the
      // client disconnects during the async subscribe() above (chokidar
      // initial-scan + pre-ready buffer flush). Without this branch,
      // the late `reply.sse.onClose(unsubscribe)` push lands on an
      // already-drained close-callback array and never fires, leaking
      // the watcher subscription.
      if (closedDuringSubscribe) {
        unsubscribe();
        return;
      }
      reply.sse.onClose(unsubscribe);
      reply.sse.keepAlive();

      // Initial `connected` event identifying the subscription target.
      await reply.sse.send({ event: 'connected', data: { projectId: id } });
    }
  );
}
