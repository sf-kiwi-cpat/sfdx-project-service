import { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { listTemplates } from '../domain/templates.js';

export async function templateRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/templates',
    {
      schema: {
        response: {
          200: Type.Array(
            Type.Object({
              id: Type.String(),
              name: Type.String(),
            })
          ),
        },
      },
    },
    async (_request, reply) => {
      const templates = await listTemplates();
      return reply.send(templates);
    }
  );
}
