declare module 'swagger-jsdoc' {
  interface OAS3Options {
    apis?: readonly string[];
    definition?: {
      openapi: string;
      info: { title: string; description?: string; version: string; [key: string]: unknown };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }
  function swaggerJsdoc(options?: OAS3Options): object;
  export = swaggerJsdoc;
}

declare module 'swagger-ui-express' {
  import { RequestHandler } from 'express';
  export const serve: RequestHandler[];
  export function setup(swaggerDoc?: object | null, opts?: Record<string, unknown>): RequestHandler;
}
