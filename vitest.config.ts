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

import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { execSync } from 'child_process';

// Determine if we're on main branch
const isMainBranch = (() => {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    return branch === 'main';
  } catch {
    return false;
  }
})();

// Use different thresholds for main vs branches
const thresholds = isMainBranch
  ? { lines: 90, branches: 90, functions: 90, statements: 90 }
  : { lines: 85, branches: 85, functions: 85, statements: 85 };

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'spec/**/*.spec.ts'],
    // Exclude the tier-3 live deploy suite from default runs — it
    // targets a real Salesforce org and has its own entry point
    // (`npm run test:deploy:live`). If you want to opt in without the
    // script, pass the path to vitest explicitly.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/live/**'],
    // Run test files serially. Several specs perform global-state
    // operations (spec/npm-package runs `npm run build`, which wipes
    // and regenerates templates/dist/; spec/fs-events spawns chokidar
    // watchers on the shared templates output). When these files run
    // concurrently, one's mutations race against another's reads and
    // cause non-deterministic failures. Tests must be deterministic
    // (see tests/CLAUDE.md), and the cost of serialisation is small.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.test.ts'],
      thresholds,
    },
  },
});
