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
import { getTemplatesDir } from '../config.js';
import { logger } from '../logger.js';

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
  const templates = entries
    .filter((f) => f.endsWith('.zip'))
    .map((f) => ({
      id: f.replace(/\.zip$/, ''),
      name: f
        .replace(/\.zip$/, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  logger.info({ count: templates.length }, 'Listed templates');
  return templates;
}
