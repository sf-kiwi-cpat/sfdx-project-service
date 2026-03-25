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
import { buildTree } from '../domain/files.js';
import { createProject, getProjectDir } from '../domain/projects.js';

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/projects',
    {
      schema: {
        body: Type.Object({
          template: Type.Optional(Type.String()),
        }),
      },
    },
    async (request, reply) => {
      const { template } = request.body as { template?: string };
      if (!template) {
        return reply
          .status(400)
          .type(PROBLEM_JSON)
          .send(problemDetail(400, 'Bad Request', 'template is required in request body'));
      }

      const id = await createProject(template);
      return reply.status(201).send({ id });
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
      const tree = await buildTree(undefined, projectDir);
      return reply.send(tree);
    }
  );
}
