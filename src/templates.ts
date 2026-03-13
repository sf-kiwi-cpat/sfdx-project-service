import fs from 'node:fs/promises';
import path from 'node:path';

export interface Template {
  name: string;
  id: string;
}

/**
 * Directory containing template ZIP files. Resolved relative to the package root
 * (two levels up from src/ at runtime in dist/).
 */
function getTemplatesDir(): string {
  return process.env.TEMPLATES_DIR ?? path.resolve(import.meta.dirname, '..', 'templates');
}

/**
 * List available project templates by reading the templates/ directory.
 * Each .zip file becomes a template with id = filename without extension.
 */
export async function listTemplates(): Promise<Template[]> {
  const dir = getTemplatesDir();
  const entries = await fs.readdir(dir);
  return entries
    .filter((f) => f.endsWith('.zip'))
    .map((f) => ({
      id: f.replace(/\.zip$/, ''),
      name: f
        .replace(/\.zip$/, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
