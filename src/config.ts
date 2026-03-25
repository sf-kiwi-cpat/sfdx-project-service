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
import path from 'node:path';

/**
 * Project root - where the SFDX project lives. Defaults to cwd; can be overridden via env for EFS mount.
 * Read at call time to support test isolation.
 */
export function getProjectPath(): string {
  return process.env.PROJECT_ROOT ?? process.cwd();
}

/**
 * Root directory for created projects. Each project gets a UUID subdirectory.
 */
export function getProjectsRoot(): string {
  return process.env.PROJECTS_ROOT ?? path.resolve(process.cwd(), 'projects');
}

/**
 * Directory containing template ZIP files. Resolved relative to the package root
 * (one level up from dist/ at runtime).
 */
export function getTemplatesDir(): string {
  return process.env.TEMPLATES_DIR ?? path.resolve(import.meta.dirname, '..', 'templates', 'dist');
}
