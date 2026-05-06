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

import fs from 'node:fs/promises';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { getProjectDir } from '../domain/projects.js';
import {
  ProjectVisualizationEngine,
  getPlatformCssPath,
  readPluginIndexHtml,
  resolvePluginAssetPath,
} from '../domain/visualize.js';
import { problemJsonResponse } from '../errors.js';

const ProjectParams = Type.Object({
  id: Type.String({ description: 'Project identifier returned by create/list endpoints.' }),
});

const UiParams = Type.Object({
  id: Type.String({ description: 'Project identifier returned by create/list endpoints.' }),
  pluginId: Type.String({
    description:
      'Visualizer plugin id (e.g. `schema`) — must match an entry from `GET /visualize/plugins`.',
  }),
});

const AssetParams = Type.Object({
  id: Type.String({ description: 'Project identifier returned by create/list endpoints.' }),
  pluginId: Type.String({
    description:
      'Visualizer plugin id (e.g. `schema`) — must match an entry from `GET /visualize/plugins`.',
  }),
  '*': Type.String({
    description: 'Asset path beneath the plugin build directory, e.g. `index-AbCd1234.js`.',
  }),
});

const VisualizeBody = Type.Object(
  {
    filePath: Type.String({
      minLength: 1,
      description: 'Project-relative path to the metadata file to visualize.',
    }),
  },
  { additionalProperties: false }
);

/**
 * Guess MIME type for a plugin asset. Vite-built plugins ship hashed `.js`
 * and `.css` files; everything else gets a generic content type so the
 * browser can sniff. We don't import a mime database — only two extensions
 * actually ship in the plugin bundles today.
 */
const MIME_BY_EXT: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function mimeForAsset(assetPath: string): string {
  const ext = path.extname(assetPath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export async function visualizeRoutes(app: FastifyInstance): Promise<void> {
  // One framework engine per project, scoped to this Fastify app instance so
  // test runs get clean state and close tidies up. The engine owns async
  // setup (plugin registry, React build base path) that is expensive to
  // rebuild per request, and internal serialization protects the single-
  // subscriber ErrorManager slot.
  const engines = new Map<string, Promise<ProjectVisualizationEngine>>();

  async function getOrCreateEngine(projectId: string): Promise<ProjectVisualizationEngine> {
    const existing = engines.get(projectId);
    if (existing) return existing;
    const projectDir = await getProjectDir(projectId);
    const promise = ProjectVisualizationEngine.create(projectDir);
    engines.set(projectId, promise);
    try {
      return await promise;
    } catch (err) {
      engines.delete(projectId);
      throw err;
    }
  }

  app.addHook('onClose', async () => {
    const pending = Array.from(engines.values());
    engines.clear();
    for (const p of pending) {
      try {
        (await p).dispose();
      } catch {
        /* engine failed to initialize — nothing to dispose */
      }
    }
  });

  app.get(
    '/projects/:id/visualize/plugins',
    {
      schema: {
        summary: 'List registered visualizer plugins',
        description:
          'Returns every plugin the Metadata Visualizer framework has registered ' +
          'for this project, including the file patterns each plugin handles.',
        tags: ['Projects'],
        params: ProjectParams,
        response: {
          200: {
            description: 'The list of registered plugins.',
            ...Type.Object({
              plugins: Type.Array(
                Type.Object(
                  {
                    id: Type.String(),
                    name: Type.String(),
                    description: Type.Optional(Type.String()),
                    author: Type.String(),
                    filePatterns: Type.Array(Type.String()),
                    priority: Type.Optional(Type.Number()),
                  },
                  { additionalProperties: true }
                )
              ),
            }),
          },
          404: problemJsonResponse('No project exists with the supplied id.'),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await getProjectDir(id);
      const engine = await getOrCreateEngine(id);
      return reply.send({ plugins: engine.listPlugins() });
    }
  );

  app.get(
    '/projects/:id/visualize/files',
    {
      schema: {
        summary: 'List project files visualizer plugins can handle',
        description:
          'Walks the project for metadata files that any registered plugin claims. ' +
          'Each entry includes the project-relative path (forward-slashed), the ' +
          'file name, and the id of the plugin that handles it.',
        tags: ['Projects'],
        params: ProjectParams,
        response: {
          200: {
            description: 'The list of files visualizer plugins can handle.',
            ...Type.Object({
              files: Type.Array(
                Type.Object(
                  {
                    path: Type.String(),
                    fileName: Type.String(),
                    pluginId: Type.String(),
                  },
                  { additionalProperties: true }
                )
              ),
            }),
          },
          404: problemJsonResponse('No project exists with the supplied id.'),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const projectDir = await getProjectDir(id);
      const engine = await getOrCreateEngine(id);
      return reply.send({ files: await engine.listHandledFiles(projectDir) });
    }
  );

  app.post(
    '/projects/:id/visualize',
    {
      schema: {
        summary: 'Parse a metadata file and return plugin-shaped data',
        description:
          'Dispatches the given file to the plugin whose `canHandle()` claims it, ' +
          'returning the plugin-defined data payload. The `data` shape is a ' +
          "plugin contract — the schema plugin returns an ERD's " +
          '`{objects, relationships, metadata}`.',
        tags: ['Projects'],
        params: ProjectParams,
        body: VisualizeBody,
        response: {
          200: {
            description: 'Plugin-shaped visualization payload.',
            ...Type.Object(
              {
                ok: Type.Literal(true),
                pluginId: Type.String(),
                filePath: Type.String(),
                data: Type.Unknown(),
              },
              { additionalProperties: true }
            ),
          },
          400: problemJsonResponse(
            'Request body is invalid, or the path escapes the project root.'
          ),
          404: problemJsonResponse('Either the project or the requested file does not exist.'),
          415: problemJsonResponse('No registered plugin handles this file type.'),
          500: problemJsonResponse('The plugin matched but failed to produce a visualization.'),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { filePath } = request.body as { filePath: string };
      const projectDir = await getProjectDir(id);
      const engine = await getOrCreateEngine(id);
      const { pluginId, data } = await engine.visualizeFile(projectDir, filePath);
      return reply.send({ ok: true, pluginId, filePath, data });
    }
  );

  // Both `/ui/:pluginId` and `/ui/:pluginId/` resolve to the same handler.
  // Relative asset paths inside the plugin HTML (e.g. `./assets/foo.js`)
  // only work when the browser's base URL includes the trailing slash, so
  // the slash-terminated route is what browsers will hit; the slash-less
  // form is a convenience alias for API consumers.
  for (const ui of [
    '/projects/:id/visualize/ui/:pluginId/',
    '/projects/:id/visualize/ui/:pluginId',
  ] as const) {
    app.get(
      ui,
      {
        schema: {
          summary: "Serve a plugin's React index.html",
          description:
            "Returns the plugin's prebuilt `index.html` with two host-side " +
            'adaptations: `@dist/` placeholders are rewritten to the project-scoped ' +
            '`/visualize/platform/` route, and a `<script>` is injected that defines ' +
            '`window.__ExtensionHostPostMessage` so the plugin can talk to the host ' +
            'frame via `postMessage`.',
          tags: ['Projects'],
          params: UiParams,
          response: {
            200: {
              description: 'The transformed plugin index.html.',
              content: {
                'text/html': { schema: { type: 'string' } },
              },
            },
            404: problemJsonResponse('Unknown project or pluginId.'),
          },
        },
      },
      async (request, reply) => {
        const { id, pluginId } = request.params as { id: string; pluginId: string };
        await getProjectDir(id);
        const engine = await getOrCreateEngine(id);
        const html = await readPluginIndexHtml(engine, pluginId, id);
        return reply.type('text/html; charset=utf-8').send(html);
      }
    );
  }

  app.get(
    '/projects/:id/visualize/ui/:pluginId/assets/*',
    {
      schema: {
        summary: "Serve a plugin's static build asset",
        description:
          "Streams a hashed JS/CSS/asset file from the plugin's build directory. " +
          'The service rejects paths that resolve outside the build dir so ' +
          '`..%2F..%2Fetc%2Fpasswd`-style traversal attempts fail.',
        tags: ['Projects'],
        params: AssetParams,
        response: {
          200: {
            description: 'The asset bytes.',
            content: {
              'application/javascript': { schema: { type: 'string' } },
              'text/css': { schema: { type: 'string' } },
            },
          },
          400: problemJsonResponse('Asset path is invalid or escapes the build dir.'),
          404: problemJsonResponse('Unknown project, plugin, or asset.'),
        },
      },
    },
    async (request, reply) => {
      const { id, pluginId } = request.params as { id: string; pluginId: string };
      const rawAsset = (request.params as { '*': string })['*'];
      await getProjectDir(id);
      const engine = await getOrCreateEngine(id);
      const absolute = resolvePluginAssetPath(engine, pluginId, rawAsset);
      const contents = await fs.readFile(absolute);
      return reply.type(mimeForAsset(rawAsset)).send(contents);
    }
  );

  app.get(
    '/projects/:id/visualize/platform/design-system/platform.css',
    {
      schema: {
        summary: 'Serve the design-system CSS referenced by plugin HTML',
        description:
          "Returns the core-sdk's shipped design-system stylesheet, served as " +
          '`platform.css` to match the `@dist/design-system/platform.css` ' +
          'placeholder the plugins emit.',
        tags: ['Projects'],
        params: ProjectParams,
        response: {
          200: {
            description: 'The design-system CSS.',
            content: {
              'text/css': { schema: { type: 'string' } },
            },
          },
          404: problemJsonResponse('Project does not exist.'),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await getProjectDir(id);
      const css = await fs.readFile(getPlatformCssPath(), 'utf-8');
      return reply
        .type('text/css; charset=utf-8')
        .header('cache-control', 'public, max-age=300')
        .send(css);
    }
  );
}
