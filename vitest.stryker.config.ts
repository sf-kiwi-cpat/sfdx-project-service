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

/**
 * Vitest configuration scoped to `tests/unit/**` for use under Stryker.
 *
 * Why a separate config file (instead of reusing `vitest.config.ts` and
 * narrowing via `vitest.dir` in `stryker.config.json`):
 *
 * - Stryker's `@stryker-mutator/vitest-runner` exposes a `dir` option
 *   that maps to the `--dir` CLI flag, but `--dir` filters against the
 *   *resolved* include glob, not the include pattern itself. Our base
 *   config's include picks up `tests` and `spec` test files; passing
 *   `--dir tests/unit` still discovers integration and spec candidates
 *   and Stryker reports "no tests were executed" once vitest's
 *   `related` filter then drops them all (our tests import
 *   `../../src/foo.js` which the related-files dependency graph can't
 *   resolve cleanly).
 *
 * - Disabling `vitest.related` and pointing Stryker at the base config
 *   surfaces a different problem: the dry run executes ALL tests
 *   (including spec), and several spec tests fail under Stryker's
 *   modified globals (`expected 202 ... got 400` from auth-resolution
 *   specs that need real ENV plumbing). That's the case the issue body
 *   is explicit about avoiding — racy specs and Stryker concurrency.
 *
 * Pinning `include` here to the unit-test glob only is the cleanest
 * fix. Coverage thresholds and `fileParallelism: false` are irrelevant
 * under Stryker (Stryker drives its own concurrency model and computes
 * its own quality metric), so we drop them too.
 *
 * Source of truth for the issue this implements: GitHub #241.
 */

import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
