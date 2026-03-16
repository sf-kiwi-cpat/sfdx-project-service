import fs from 'node:fs/promises';
import { getTemplatesDir } from './config.js';

export interface Template {
  name: string;
  id: string;
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
