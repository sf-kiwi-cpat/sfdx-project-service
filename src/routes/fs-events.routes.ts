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

const ProjectParams = Type.Object({ id: Type.String() });

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
        params: ProjectParams,
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
