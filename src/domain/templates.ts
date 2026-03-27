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
import { getTemplatesDir } from '../config.js';
import { logger } from '../logger.js';

export interface Template {
  id: string;
  name: string;
  description: string;
}

/**
 * List available project templates by reading template.json from each
 * subdirectory of the templates/ directory.
 */
export async function listTemplates(): Promise<Template[]> {
  const dir = getTemplatesDir();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const templates: Template[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name, 'template.json'), 'utf-8');
      const meta = JSON.parse(raw) as Template;
      templates.push({ id: meta.id, name: meta.name, description: meta.description ?? '' });
    } catch {
      // Skip directories without a valid template.json
    }
  }

  templates.sort((a, b) => a.id.localeCompare(b.id));
  logger.info({ count: templates.length }, 'Listed templates');
  return templates;
}
