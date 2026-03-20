import { FastifyInstance } from 'fastify';
import { templateRoutes } from './templates.routes.js';
import { projectRoutes } from './projects.routes.js';
import { deployRoutes } from './deploy.routes.js';

export async function routes(app: FastifyInstance): Promise<void> {
  app.register(templateRoutes);
  app.register(projectRoutes);
  app.register(deployRoutes);
}
