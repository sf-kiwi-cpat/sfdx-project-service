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
import { listTemplates } from '../domain/templates.js';

const TemplateListItem = Type.Object({
  id: Type.String({ description: 'Stable identifier for the template.' }),
  name: Type.String({ description: 'Display name of the template.' }),
  description: Type.String({
    description: 'Short explanation of what the template scaffolds.',
  }),
  categories: Type.Array(Type.String(), {
    description: 'Classification tags used by IDE UIs for grouping.',
  }),
});

export async function templateRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/templates',
    {
      schema: {
        summary: 'List available SFDX project templates',
        description:
          'Returns the catalog of templates that can be used when creating a ' +
          'new project via POST /v1/projects. Each entry is a stable handle; ' +
          'templates never disappear silently.',
        tags: ['Templates'],
        response: {
          200: {
            description: 'Array of available templates.',
            ...Type.Array(TemplateListItem),
          },
        },
      },
    },
    async (_request, reply) => {
      const templates = await listTemplates();
      return reply.send(templates);
    }
  );
}
