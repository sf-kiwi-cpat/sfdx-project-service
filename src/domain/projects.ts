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

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import extract from 'extract-zip';
import { TemplateService, TemplateType } from '@salesforce/templates';
import type { ProjectOptions } from '@salesforce/templates';
import { getProjectsRoot, getTemplatesDir } from '../config.js';
import { logger } from '../logger.js';
import { resolveAlias, writeProjectTargetOrg } from './auth.js';
import { uniquifyAppNames } from './app-naming.js';
import { watcherManager } from './watcher.js';

const ADJECTIVES = [
  'brave',
  'calm',
  'dark',
  'eager',
  'fair',
  'glad',
  'happy',
  'keen',
  'bold',
  'cool',
  'deep',
  'fast',
  'gold',
  'high',
  'kind',
  'lean',
  'mild',
  'neat',
  'pure',
  'rich',
  'safe',
  'soft',
  'true',
  'warm',
  'wise',
  'wild',
  'swift',
  'stark',
  'prime',
  'rare',
];

const NOUNS = [
  'falcon',
  'river',
  'storm',
  'cedar',
  'flame',
  'frost',
  'grove',
  'haven',
  'brook',
  'cliff',
  'coral',
  'crane',
  'delta',
  'drift',
  'ember',
  'field',
  'forge',
  'glade',
  'heron',
  'lotus',
  'maple',
  'north',
  'ocean',
  'pearl',
  'ridge',
  'shore',
  'spark',
  'stone',
  'tower',
  'valley',
];

const META_FILE = '.project-meta.json';

export interface Message {
  role: string;
  content: string;
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m.role === 'string' && typeof m.content === 'string';
}

interface ProjectMeta {
  name: string;
  lastAccessedAt?: string;
  initialMessages?: Message[];
  // Per-project token suffixed onto singular-shipped metadata DeveloperNames
  // (UIBundle, CustomApplication) so concurrent deploys to a shared org
  // don't collide. See spec/app-naming/contract.md.
  appNameToken?: string;
}

function generateName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

async function writeProjectMeta(projectDir: string, meta: ProjectMeta): Promise<void> {
  // Write to a same-directory tmp file and rename into place. fs.rename is
  // atomic on POSIX and on Windows for same-volume renames, so a concurrent
  // reader either observes the old file or the new file — never a truncated
  // mid-write state. Prevents the race that corrupted meta files under load.
  const finalPath = path.join(projectDir, META_FILE);
  const tmpPath = path.join(projectDir, `${META_FILE}.${randomUUID()}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2) + '\n');
  try {
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
}

async function readProjectMetaFile(projectDir: string): Promise<ProjectMeta | null> {
  try {
    const raw = await fs.readFile(path.join(projectDir, META_FILE), 'utf-8');
    return JSON.parse(raw) as ProjectMeta;
  } catch {
    return null;
  }
}

async function readProjectMeta(projectDir: string): Promise<ProjectMeta> {
  return (await readProjectMetaFile(projectDir)) ?? { name: path.basename(projectDir) };
}

export async function updateLastAccessed(projectDir: string): Promise<void> {
  const meta = await readProjectMetaFile(projectDir);
  if (!meta) {
    // Writing the display-side fallback here would persist { name: <uuid> }
    // and permanently corrupt the project. An explicit write (e.g.
    // renameProject) is the only legitimate recovery path.
    logger.warn({ projectDir }, 'skipping lastAccessedAt bump — meta file missing or unparseable');
    return;
  }
  meta.lastAccessedAt = new Date().toISOString();
  await writeProjectMeta(projectDir, meta);
}

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

export interface ProjectResult {
  id: string;
  name: string;
  lastAccessedAt: string;
  targetOrg?: string;
  initialMessages?: Message[];
}

/**
 * Validate an orgAlias against the Salesforce auth store.
 * Returns the resolved username, or throws OrgAliasNotFoundError.
 */
export class OrgAliasNotFoundError extends Error {
  constructor(alias: string) {
    super(`Org alias not found in auth store: ${alias}`);
    this.name = 'OrgAliasNotFoundError';
  }
}

export class OrgAliasEmptyError extends Error {
  constructor() {
    super('orgAlias must be a non-empty string');
    this.name = 'OrgAliasEmptyError';
  }
}

/**
 * Create a blank SFDX project using the official SF template library.
 * Uses the 'empty' project template from @salesforce/templates.
 *
 * If orgAlias is provided, validates it against the auth store and
 * persists the target-org in the project's .sf/config.json.
 */
export async function createBlankProject(orgAlias?: string): Promise<ProjectResult> {
  // Validate orgAlias if provided
  if (orgAlias !== undefined) {
    if (orgAlias === '') {
      throw new OrgAliasEmptyError();
    }
    const username = await resolveAlias(orgAlias);
    if (!username) {
      throw new OrgAliasNotFoundError(orgAlias);
    }
  }

  const projectId = randomUUID();
  const projectsRoot = getProjectsRoot();

  const options: ProjectOptions = {
    projectname: projectId,
    template: 'empty',
    defaultpackagedir: 'force-app',
    ns: '',
    loginurl: 'https://login.salesforce.com',
    manifest: false,
    outputdir: projectsRoot,
  };

  try {
    const service = new TemplateService(projectsRoot);
    await service.create(TemplateType.Project, options);
  } catch (err) {
    await fs.rm(path.join(projectsRoot, projectId), { recursive: true, force: true });
    throw err;
  }

  const projectDir = path.join(projectsRoot, projectId);
  const name = generateName();
  const lastAccessedAt = new Date().toISOString();
  await writeProjectMeta(projectDir, { name, lastAccessedAt });

  // Persist target-org if orgAlias was provided
  if (orgAlias) {
    await writeProjectTargetOrg(projectDir, orgAlias);
    logger.info({ projectId, name, orgAlias }, 'Blank project created with target-org');
    return { id: projectId, name, lastAccessedAt, targetOrg: orgAlias };
  }

  logger.info({ projectId, name }, 'Blank project created');
  return { id: projectId, name, lastAccessedAt };
}

/**
 * Create a new project by unzipping a template into a UUID-named directory.
 */
export async function createProject(templateId: string): Promise<ProjectResult> {
  // Sanitize templateId — only allow alphanumeric, hyphens, underscores
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(templateId)) {
    throw new TemplateNotFoundError(templateId);
  }

  // Validate template exists
  const templatePath = path.join(getTemplatesDir(), templateId, 'content.zip');
  try {
    await fs.access(templatePath);
  } catch {
    throw new TemplateNotFoundError(templateId);
  }

  // Create project directory
  const projectId = randomUUID();
  const projectDir = path.join(getProjectsRoot(), projectId);
  await fs.mkdir(projectDir, { recursive: true });

  // extract-zip is async (yauzl-backed) so a ~40 MB template extraction
  // does not stall the event loop. Entry modes are honored from the zip
  // itself — the build path in scripts/zip-templates.js embeds Unix mode
  // bits, so we don't need defaultFileMode / defaultDirMode.
  try {
    // extract-zip's `dir` option requires an absolute path.
    await extract(templatePath, { dir: path.resolve(projectDir) });
  } catch (err) {
    await fs.rm(projectDir, { recursive: true, force: true });
    throw err;
  }

  // Suffix singular-shipped metadata DeveloperNames (UIBundle,
  // CustomApplication) with a per-project token so concurrent deploys
  // to the same Salesforce org don't collide. See spec/app-naming.
  const appNameToken = await uniquifyAppNames(projectDir);

  const name = generateName();
  const lastAccessedAt = new Date().toISOString();

  let initialMessages: Message[] | undefined;
  try {
    const raw = await fs.readFile(
      path.join(getTemplatesDir(), templateId, 'template.json'),
      'utf-8'
    );
    const templateMeta = JSON.parse(raw) as { initialMessages?: unknown };
    if (Array.isArray(templateMeta.initialMessages)) {
      const valid = templateMeta.initialMessages.filter(isMessage);
      if (valid.length > 0) {
        initialMessages = valid;
      }
    }
  } catch {
    // template.json is optional for initialMessages; absence is not an error
  }

  const meta: ProjectMeta = { name, lastAccessedAt, appNameToken };
  if (initialMessages) {
    meta.initialMessages = initialMessages;
  }
  await writeProjectMeta(projectDir, meta);

  logger.info({ projectId, templateId, name, appNameToken }, 'Project created from template');
  const result: ProjectResult = { id: projectId, name, lastAccessedAt };
  if (initialMessages) {
    result.initialMessages = initialMessages;
  }
  return result;
}

/**
 * List all projects in the projects root directory.
 */
export async function listProjects(): Promise<ProjectResult[]> {
  const projectsRoot = getProjectsRoot();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  let entries: string[];
  try {
    entries = await fs.readdir(projectsRoot);
  } catch {
    return [];
  }

  const results: ProjectResult[] = [];
  for (const entry of entries) {
    if (!UUID_RE.test(entry)) continue;
    const entryPath = path.join(projectsRoot, entry);
    const stat = await fs.stat(entryPath);
    if (!stat.isDirectory()) continue;
    const meta = await readProjectMeta(entryPath);
    const lastAccessedAt = meta.lastAccessedAt ?? stat.birthtime.toISOString();
    results.push({ id: entry, name: meta.name, lastAccessedAt });
  }
  return results;
}

/**
 * Get a project by ID. Bumps lastAccessedAt and returns the post-bump
 * record. Throws ProjectNotFoundError if the project does not exist or
 * the ID fails UUID validation.
 */
export async function getProject(projectId: string): Promise<ProjectResult> {
  const projectDir = await getProjectDir(projectId);
  await updateLastAccessed(projectDir);
  const meta = await readProjectMeta(projectDir);
  const result: ProjectResult = {
    id: projectId,
    name: meta.name,
    lastAccessedAt: meta.lastAccessedAt ?? new Date().toISOString(),
  };
  if (meta.initialMessages) {
    result.initialMessages = meta.initialMessages;
  }
  return result;
}

/**
 * Rename a project. Throws if the project doesn't exist.
 */
export async function renameProject(projectId: string, name: string): Promise<ProjectResult> {
  const projectDir = await getProjectDir(projectId);
  const existingMeta = await readProjectMeta(projectDir);
  const lastAccessedAt = new Date().toISOString();
  await writeProjectMeta(projectDir, {
    ...existingMeta,
    name,
    lastAccessedAt,
  });
  logger.info({ projectId, name }, 'Project renamed');
  return { id: projectId, name, lastAccessedAt };
}

/**
 * Delete a project's directory from disk. Throws ProjectNotFoundError if the
 * id is not a UUID, the directory does not exist, or the path does not point
 * at a directory. No org-side cleanup — this only touches local disk.
 */
export async function deleteProject(projectId: string): Promise<void> {
  const projectDir = await getProjectDir(projectId);
  // Close any active fs-events SSE subscribers and tear down the per-project
  // chokidar watcher BEFORE removing the directory. Doing this first means:
  //   - Connected clients see the stream end as part of DELETE's lifetime,
  //     not after a delay.
  //   - chokidar doesn't fire a flurry of `unlink` events from the rm we're
  //     about to do (the watcher is already gone).
  // No-op if no watcher exists for this project.
  await watcherManager.closeForProject(projectId);
  // force: false so a dir that disappeared between the existence check above
  // and this rm still surfaces ENOENT — letting a concurrent second DELETE
  // return 404 instead of silently succeeding.
  await fs.rm(projectDir, { recursive: true, force: false });
  logger.info({ projectId }, 'Project deleted');
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
