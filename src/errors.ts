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

import {
  TemplateNotFoundError,
  ProjectNotFoundError,
  OrgAliasNotFoundError,
  OrgAliasEmptyError,
} from './domain/projects.js';

/** Thrown when a Salesforce deployment fails. */
export class DeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentError';
  }
}

/** Thrown when a deployment with the given ID is not registered. */
export class DeploymentNotFoundError extends Error {
  constructor(deploymentId: string) {
    super(`Deployment ${deploymentId} not found`);
    this.name = 'DeploymentNotFoundError';
  }
}

/** Thrown when a Vite build step fails or times out. */
export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildError';
  }
}

/**
 * RFC 9457 Problem Details for HTTP APIs
 * https://www.rfc-editor.org/rfc/rfc9457.html
 */
export interface ProblemDetail {
  status: number;
  title: string;
  detail: string;
  type?: string;
  instance?: string;
}

export function problemDetail(status: number, title: string, detail: string): ProblemDetail {
  return { status, title, detail };
}

export const PROBLEM_JSON = 'application/problem+json';

/** Maximum allowed path length (characters). Paths longer than this are rejected before fs calls. */
export const MAX_PATH_LENGTH = 1024;

/** Thrown when a path resolves into .sf/, .git/, node_modules/, or dotfiles. */
export class RestrictedPathError extends Error {
  constructor() {
    super('Access to this path is restricted');
    this.name = 'RestrictedPathError';
  }
}

/** Thrown when a path escapes the project root (path traversal). */
export class PathTraversalError extends Error {
  constructor(queryPath: string) {
    super(`Path escapes project root: ${queryPath}`);
    this.name = 'PathTraversalError';
  }
}

/** Thrown when a file does not exist at the given path. */
export class FileNotFoundError extends Error {
  constructor(path: string) {
    super(`No file exists at path '${path}'`);
    this.name = 'FileNotFoundError';
  }
}

/** Thrown when the path refers to a directory, not a file. */
export class NotAFileError extends Error {
  constructor(path: string) {
    super(`Not a file: ${path}`);
    this.name = 'NotAFileError';
  }
}

/** Thrown when the path length exceeds MAX_PATH_LENGTH. */
export class PathTooLongError extends Error {
  constructor(length: number) {
    super(`Path length ${length} exceeds maximum allowed length of ${MAX_PATH_LENGTH}`);
    this.name = 'PathTooLongError';
  }
}

/**
 * Map thrown errors to HTTP problem details.
 */
export function errorToProblem(err: unknown): ProblemDetail {
  if (err instanceof OrgAliasEmptyError) {
    return problemDetail(400, 'Bad Request', err.message);
  }
  if (err instanceof OrgAliasNotFoundError) {
    return problemDetail(400, 'Bad Request', err.message);
  }
  if (err instanceof TemplateNotFoundError) {
    return problemDetail(400, 'Bad Request', err.message);
  }
  if (err instanceof ProjectNotFoundError) {
    return problemDetail(404, 'Project Not Found', err.message);
  }
  if (err instanceof RestrictedPathError) {
    return problemDetail(400, 'Bad Request', err.message);
  }
  if (err instanceof PathTraversalError) {
    return problemDetail(400, 'Bad Request', err.message);
  }
  if (err instanceof FileNotFoundError) {
    return problemDetail(404, 'File Not Found', err.message);
  }
  if (err instanceof NotAFileError) {
    return problemDetail(400, 'Bad Request', err.message);
  }
  if (err instanceof PathTooLongError) {
    return problemDetail(400, 'Bad Request', err.message);
  }
  if (err instanceof BuildError) {
    return problemDetail(502, 'Build Failed', err.message);
  }
  if (err instanceof DeploymentError) {
    return problemDetail(502, 'Deployment Failed', err.message);
  }
  if (err instanceof DeploymentNotFoundError) {
    return problemDetail(404, 'Deployment Not Found', err.message);
  }

  // Fastify validation errors (e.g. missing required querystring params)
  const fastifyErr = err as { statusCode?: number; validation?: unknown[] };
  if (fastifyErr?.statusCode && fastifyErr.validation) {
    return problemDetail(fastifyErr.statusCode, 'Bad Request', (err as Error).message);
  }

  const nodeErr = err as NodeJS.ErrnoException;
  if (nodeErr?.code === 'ENOENT') {
    return problemDetail(404, 'File Not Found', 'File not found');
  }
  if (nodeErr?.code === 'ENAMETOOLONG') {
    return problemDetail(400, 'Bad Request', 'Path is too long');
  }

  // Forward err.message only for plain Errors (not ErrnoException).
  // ErrnoException messages may contain absolute paths and are suppressed above.
  if (err instanceof Error && (err as NodeJS.ErrnoException).code === undefined) {
    return problemDetail(500, 'Internal Server Error', err.message);
  }
  return problemDetail(500, 'Internal Server Error', 'Internal server error');
}
