import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
 * Root directory for created projects. Each project gets a UUID subdirectory.
 */
function getProjectsRoot(): string {
  return process.env.PROJECTS_ROOT ?? path.resolve(process.cwd(), 'projects');
}

/**
 * Directory containing template ZIP files.
 */
function getTemplatesDir(): string {
  return process.env.TEMPLATES_DIR ?? path.resolve(import.meta.dirname, '..', 'templates');
}

/**
 * Create a new project by unzipping a template into a UUID-named directory.
 * Returns the project ID (UUID).
 */
export async function createProject(templateId: string): Promise<string> {
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

  // Unzip template into project directory
  await execFileAsync('unzip', ['-o', templatePath, '-d', projectDir]);

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
