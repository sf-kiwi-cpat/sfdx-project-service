/**
 * @openapi
 * components:
 *   schemas:
 *     ProblemDetail:
 *       type: object
 *       description: RFC 9457 Problem Details
 *       properties:
 *         status:
 *           type: integer
 *         title:
 *           type: string
 *         detail:
 *           type: string
 *         type:
 *           type: string
 *         instance:
 *           type: string
 *       required: [status, title, detail]
 *     TreeNode:
 *       type: object
 *       description: Recursive file-tree node
 *       properties:
 *         name:
 *           type: string
 *         type:
 *           type: string
 *           enum: [file, directory]
 *         children:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/TreeNode'
 *       required: [name, type]
 */
import express from 'express';
import { createTemplatesRouter } from './templates.routes.js';
import { createProjectsRouter } from './projects.routes.js';
import { createDeployRouter } from './deploy.routes.js';

export function createRouter(): express.Router {
  const router = express.Router();

  router.use(createTemplatesRouter());
  router.use(createProjectsRouter());
  router.use(createDeployRouter());

  return router;
}
