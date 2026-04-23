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
import { buildTree, readFile } from '../domain/files.js';
import {
  createBlankProject,
  createProject,
  getProjectDir,
  listProjects,
  renameProject,
  updateLastAccessed,
} from '../domain/projects.js';
import { problemDetail, problemJsonResponse, PROBLEM_JSON } from '../errors.js';

/**
 * Response shape for endpoints that return a project record. Marked
 * `additionalProperties: true` so fastify's response serializer doesn't strip
 * optional fields (e.g. `targetOrg`) that the domain attaches contextually.
 */
const ProjectSummary = Type.Object(
  {
    id: Type.String({ description: 'Stable identifier for the project (UUID).' }),
    name: Type.String({ description: 'Human-readable display name of the project.' }),
    lastAccessedAt: Type.String({
      description: "ISO-8601 timestamp of the project's most recent access or rename.",
    }),
    targetOrg: Type.Optional(
      Type.String({
        description: 'Salesforce org alias bound to this project, when one was supplied.',
      })
    ),
  },
  {
    description: 'Project record returned by create/rename/list endpoints.',
    additionalProperties: true,
  }
);

const TreeNodeSchema = Type.Recursive((Node) =>
  Type.Object(
    {
      name: Type.String({ description: 'Directory or file basename.' }),
      path: Type.String({
        description: 'Path relative to the project root (forward slashes on all platforms).',
      }),
      type: Type.Union([Type.Literal('file'), Type.Literal('directory')], {
        description: 'Whether the node is a file or a directory.',
      }),
      children: Type.Optional(
        Type.Array(Node, {
          description: 'Nested children (omitted for file nodes).',
        })
      ),
    },
    { additionalProperties: true }
  )
);

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/projects',
    {
      schema: {
        summary: 'Create a new SFDX project',
        description:
          'Scaffolds a new project. If `template` is provided, the project is ' +
          'bootstrapped from that template; otherwise a blank SFDX project is ' +
          "created. When `orgAlias` is provided, the project's `target-org` is " +
          'set to that alias so subsequent deploys resolve auth automatically.',
        tags: ['Projects'],
        body: Type.Object({
          template: Type.Optional(
            Type.String({
              description:
                'ID of a template returned by `GET /v1/templates`. Omit for a blank project.',
            })
          ),
          orgAlias: Type.Optional(
            Type.String({
              description:
                'Alias of an authenticated Salesforce org to set as the project `target-org`. ' +
                'Must match an existing alias known to `sf org list` on the host.',
            })
          ),
        }),
        response: {
          201: {
            ...ProjectSummary,
            description: 'The newly created project.',
          },
          400: problemJsonResponse(
            'The request body is invalid — for example, `template` references an ' +
              'unknown template, or `orgAlias` does not match any authenticated org.'
          ),
        },
      },
    },
    async (request, reply) => {
      const { template, orgAlias } = request.body as { template?: string; orgAlias?: string };
      const result = template ? await createProject(template) : await createBlankProject(orgAlias);
      return reply.status(201).send(result);
    }
  );

  app.get(
    '/projects',
    {
      schema: {
        summary: 'List existing projects',
        description:
          'Returns every project currently managed by the service, most-recently ' +
          'accessed first. Use this to populate IDE project pickers.',
        tags: ['Projects'],
        response: {
          200: {
            description: 'Array of project records.',
            ...Type.Array(ProjectSummary),
          },
        },
      },
    },
    async (_request, reply) => {
      const projects = await listProjects();
      return reply.send(projects);
    }
  );

  app.patch(
    '/projects/:id',
    {
      schema: {
        summary: 'Rename a project',
        description:
          "Updates a project's display name. The on-disk project directory is " +
          'not moved; only the `name` stored in project metadata changes.',
        tags: ['Projects'],
        params: Type.Object({
          id: Type.String({ description: 'Project identifier returned by create/list endpoints.' }),
        }),
        body: Type.Object({
          name: Type.Optional(
            Type.String({
              description: 'New human-readable name for the project. Must be a non-empty string.',
            })
          ),
        }),
        response: {
          200: {
            ...ProjectSummary,
            description: 'The renamed project.',
          },
          400: problemJsonResponse(
            'The request body is invalid — `name` is missing, empty, or not a string.'
          ),
          404: problemJsonResponse('No project exists with the supplied id.'),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { name } = request.body as { name?: string };

      if (!name || typeof name !== 'string' || name.length === 0) {
        return reply
          .status(400)
          .type(PROBLEM_JSON)
          .send(
            problemDetail(400, 'Bad Request', 'name is required and must be a non-empty string')
          );
      }

      const result = await renameProject(id, name);
      return reply.send(result);
    }
  );

  app.get(
    '/projects/:id/file',
    {
      schema: {
        summary: 'Read a project file as plain text',
        description:
          'Returns the raw contents of a file inside the project. Paths are ' +
          'resolved relative to the project root; attempts to escape via `..` ' +
          'are rejected with 400. Restricted paths (`.git/`, `.sf/`, ' +
          '`node_modules/`, dotfiles) return 400.',
        tags: ['Projects'],
        params: Type.Object({
          id: Type.String({ description: 'Project identifier returned by create/list endpoints.' }),
        }),
        querystring: Type.Object({
          path: Type.String({
            description:
              'File path relative to the project root. Must not traverse outside the project (`..`).',
          }),
        }),
        response: {
          200: {
            description: 'The file contents as UTF-8 text.',
            content: {
              'text/plain': {
                schema: {
                  type: 'string',
                  description: 'Raw file contents as UTF-8 text.',
                },
              },
            },
          },
          400: problemJsonResponse(
            'The path is missing, exceeds the maximum length, traverses outside ' +
              'the project root, resolves to a restricted path, or refers to a directory.'
          ),
          404: problemJsonResponse('Either the project or the requested file does not exist.'),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { path } = request.query as { path: string };
      const projectDir = await getProjectDir(id);
      await updateLastAccessed(projectDir);
      const content = await readFile(path, projectDir);
      return reply.type('text/plain').send(content);
    }
  );

  app.get(
    '/projects/:id/tree',
    {
      schema: {
        summary: 'Read the project directory tree',
        description:
          'Returns a recursive tree of every non-restricted file and directory ' +
          'inside the project. Hidden entries (`.git/`, `.sf/`, `node_modules/`, ' +
          'dotfiles) are pruned to match what the `file` endpoint will actually serve.',
        tags: ['Projects'],
        params: Type.Object({
          id: Type.String({ description: 'Project identifier returned by create/list endpoints.' }),
        }),
        response: {
          200: {
            description: 'The project tree rooted at the project directory.',
            ...TreeNodeSchema,
          },
          404: problemJsonResponse('No project exists with the supplied id.'),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const projectDir = await getProjectDir(id);
      await updateLastAccessed(projectDir);
      const tree = await buildTree(undefined, projectDir);
      return reply.send(tree);
    }
  );
}
