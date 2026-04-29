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
  getProject,
  getProjectDir,
  listProjects,
  renameProject,
  updateLastAccessed,
} from '../domain/projects.js';
import { problemDetail, PROBLEM_JSON } from '../errors.js';
export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/projects',
    {
      schema: {
        body: Type.Object(
          {
            template: Type.Optional(Type.String()),
            orgAlias: Type.Optional(Type.String()),
          },
          { additionalProperties: false }
        ),
      },
    },
    async (request, reply) => {
      const { template, orgAlias } = request.body as { template?: string; orgAlias?: string };
      const result = template ? await createProject(template) : await createBlankProject(orgAlias);
      return reply.status(201).send(result);
    }
  );

  app.get('/projects', async (_request, reply) => {
    const projects = await listProjects();
    return reply.send(projects);
  });

  app.get(
    '/projects/:id',
    {
      schema: {
        params: Type.Object({ id: Type.String() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await getProject(id);
      return reply.send(result);
    }
  );

  app.patch(
    '/projects/:id',
    {
      schema: {
        params: Type.Object({ id: Type.String() }),
        // Explicit body schema lets Ajv reject unknown properties via
        // `additionalProperties: false`. `name` is intentionally NOT
        // listed as a `required` property: with `allErrors: false` Ajv
        // would otherwise report the missing-`name` error first and
        // hide the offending unknown key. Instead we validate `name`'s
        // presence imperatively below, so the `additionalProperties`
        // check always surfaces the typo first.
        body: Type.Object(
          {
            name: Type.Optional(Type.String({ minLength: 1 })),
          },
          { additionalProperties: false }
        ),
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
        params: Type.Object({
          id: Type.String(),
        }),
        querystring: Type.Object({
          path: Type.String(),
        }),
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
        params: Type.Object({
          id: Type.String(),
        }),
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
