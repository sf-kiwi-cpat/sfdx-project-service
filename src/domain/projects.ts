/*
 * Copyright (c) 2026, Salesforce, Inc.
 * SPDX-License-Identifier: Apache-2
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
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { getProjectsRoot, getTemplatesDir } from '../config.js';
import { logger } from '../logger.js';

export class TemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`Template not found: ${templateId}`);
    this.name = 'TemplateNotFoundError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project not found: ${projectId}`);
    this.name = 'ProjectNotFoundError';
  }
}

/**
 * Create a new project by unzipping a template into a UUID-named directory.
 * Returns the project ID (UUID).
 */
export async function createProject(templateId: string): Promise<string> {
  // Sanitize templateId — only allow alphanumeric, hyphens, underscores
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(templateId)) {
    throw new TemplateNotFoundError(templateId);
  }

  // Validate template exists
  const templatePath = path.join(getTemplatesDir(), `${templateId}.zip`);
  try {
    await fs.access(templatePath);
  } catch {
    throw new TemplateNotFoundError(templateId);
  }

  // Create project directory
  const projectId = randomUUID();
  const projectDir = path.join(getProjectsRoot(), projectId);
  await fs.mkdir(projectDir, { recursive: true });

  // Extract template into project directory
  try {
    const zip = new AdmZip(templatePath);
    zip.extractAllTo(projectDir, true);
  } catch (err) {
    await fs.rm(projectDir, { recursive: true, force: true });
    throw err;
  }

  logger.info({ projectId, templateId }, 'Project created from template');
  return projectId;
}

/**
 * Get the absolute path for a project directory. Throws if it doesn't exist.
 */
export async function getProjectDir(projectId: string): Promise<string> {
  // Validate projectId is a valid UUID pattern to prevent path traversal
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new ProjectNotFoundError(projectId);
  }

  const projectDir = path.join(getProjectsRoot(), projectId);
  try {
    const stat = await fs.stat(projectDir);
    if (!stat.isDirectory()) {
      throw new ProjectNotFoundError(projectId);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new ProjectNotFoundError(projectId);
    }
    if (err instanceof ProjectNotFoundError) throw err;
    throw err;
  }
  return projectDir;
}
