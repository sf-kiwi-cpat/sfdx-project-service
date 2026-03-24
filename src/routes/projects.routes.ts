import { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { problemDetail, PROBLEM_JSON } from '../errors.js';
import { buildTree, readFile } from '../domain/files.js';
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
      const tree = await buildTree(undefined, projectDir);
      return reply.send(tree);
    }
  );
}
