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

/** Emit heartbeat SSE comments every 15s to keep proxies from closing idle connections. */
const HEARTBEAT_INTERVAL_MS = 15_000;

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
          404: problemJsonResponse('No project exists with the supplied id.'),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      // Validate project exists — throws ProjectNotFoundError → 404
      // (caught by the global error handler, formatted as problem+json).
      const projectDir = await getProjectDir(id);

      // Hand the raw response off to the SSE plumbing below.
      reply.hijack();
      const raw = reply.raw;

      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        // @fastify/cors runs in the Fastify response pipeline, which we bypass
        // via reply.hijack() for SSE. Set the header explicitly so browsers
        // don't block cross-origin EventSource subscriptions (matches the
        // pattern in deploy.routes.ts).
        'Access-Control-Allow-Origin': '*',
      });

      // Subscribe first — awaits chokidar's initial scan so writes made
      // immediately after the `connected` event can't be misclassified.
      const unsubscribe = await watcherManager.subscribe(id, projectDir, (evt) => {
        if (raw.writableEnded || raw.destroyed) return;
        raw.write(`event: ${sseEventName(evt.type)}\n`);
        raw.write(`data: ${JSON.stringify(evt)}\n\n`);
      });

      // Initial `connected` event identifying the subscription target.
      raw.write('event: connected\n');
      raw.write(`data: ${JSON.stringify({ projectId: id })}\n\n`);

      const heartbeat = setInterval(() => {
        /* v8 ignore next 3 -- heartbeat timing not exercised in tests */
        if (raw.writableEnded || raw.destroyed) return;
        raw.write(':heartbeat\n\n');
      }, HEARTBEAT_INTERVAL_MS);
      // Don't keep the process alive for idle subscribers.
      heartbeat.unref();

      const cleanup = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);
    }
  );
}
