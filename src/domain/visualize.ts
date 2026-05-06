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
import { createRequire } from 'node:module';
import { glob } from 'glob';
import {
  LogLevel,
  NoOpTelemetry,
  PLUGINS_DIST_DIR,
  PLUGINS_DIR,
  type IFileSystem,
  type ILogger,
  type IPlatformContext,
  type ITelemetry,
  type FileMetadata,
  type ParsedPath,
  type PluginError,
} from '@salesforce/metadata-core-sdk';
import {
  PluginManager,
  VisualizationEngine,
  type VisualizationResult,
} from '@salesforce/metadata-visualizer-core';
import { logger as appLogger } from '../logger.js';
import { resolveProjectPath } from './files.js';
import { FileNotFoundError, NotAFileError } from '../errors.js';

const require_ = createRequire(import.meta.url);

// Result shape the core-sdk uses for file-system operations. It's not exported
// as a standalone type from the package, so we mirror the structural shape.
type FsResult<T> = { success: true; data: T } | { success: false; error: Error };

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Thrown when no registered plugin can handle the given file type. */
export class UnsupportedFileTypeError extends Error {
  constructor(filePath: string) {
    super(`No registered plugin can handle: ${filePath}`);
    this.name = 'UnsupportedFileTypeError';
  }
}

/** Thrown when a plugin exists in the framework but is not registered here. */
export class PluginNotFoundError extends Error {
  constructor(pluginId: string) {
    super(`Plugin not found: ${pluginId}`);
    this.name = 'PluginNotFoundError';
  }
}

/**
 * Thrown when a plugin matched the file but the framework returned no result.
 * The framework reports a structured PluginError via ErrorManager in this case;
 * we surface it as a 500-class failure with the captured error attached.
 */
export class VisualizationFailedError extends Error {
  constructor(
    message: string,
    readonly pluginError: PluginError | null
  ) {
    super(message);
    this.name = 'VisualizationFailedError';
  }
}

class NodeFileSystem implements IFileSystem {
  constructor(private readonly workspaceRoot: string) {}

  async readFile(filePath: string): Promise<FsResult<string>> {
    try {
      return { success: true, data: await fs.readFile(filePath, 'utf-8') };
    } catch (error) {
      return { success: false, error: asError(error) };
    }
  }

  async getMetadata(filePath: string): Promise<FsResult<FileMetadata>> {
    try {
      await fs.stat(filePath);
      return {
        success: true,
        data: {
          path: filePath,
          fileName: path.basename(filePath),
          extension: path.extname(filePath),
        },
      };
    } catch (error) {
      return { success: false, error: asError(error) };
    }
  }

  async findFiles(pattern: string, maxResults?: number): Promise<FsResult<string[]>> {
    const matches = await glob(pattern, {
      cwd: this.workspaceRoot,
      nodir: true,
      absolute: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    });
    const limited = typeof maxResults === 'number' ? matches.slice(0, maxResults) : matches;
    return { success: true, data: limited };
  }

  // Methods below are interface fillers — the framework + shipped plugins
  // only call readFile / getMetadata / findFiles / basename. Kept simple
  // (no defensive try/catch) so they don't add untested branches.
  async writeFile(filePath: string, content: string): Promise<FsResult<void>> {
    await fs.writeFile(filePath, content, 'utf-8');
    return { success: true, data: undefined };
  }
  async exists(filePath: string): Promise<boolean> {
    return fs
      .stat(filePath)
      .then(() => true)
      .catch(() => false);
  }
  async readDirectory(
    dirPath: string
  ): Promise<FsResult<Array<{ name: string; isFile: boolean }>>> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return { success: true, data: entries.map((e) => ({ name: e.name, isFile: e.isFile() })) };
  }
  getWorkspaceRoot(): string | undefined {
    return this.workspaceRoot;
  }
  normalizePath(p: string): string {
    return path.normalize(p);
  }
  get separator(): string {
    return path.sep;
  }
  basename(p: string, ext?: string): string {
    return path.basename(p, ext);
  }
  dirname(p: string): string {
    return path.dirname(p);
  }
  join(...segments: string[]): string {
    return path.join(...segments);
  }
  extname(p: string): string {
    return path.extname(p);
  }
  parse(p: string): ParsedPath {
    return path.parse(p);
  }
  relative(from: string, to: string): string {
    return path.relative(from, to);
  }
  resolve(...segments: string[]): string {
    return path.resolve(...segments);
  }
  isAbsolute(p: string): boolean {
    return path.isAbsolute(p);
  }
}

/**
 * Adapter from pino-style app logger to the visualizer framework's ILogger.
 * Level filtering is already applied by pino; the framework interface just
 * needs plain sinks.
 */
class NodeLogger implements ILogger {
  debug(message: string, ...args: unknown[]): void {
    appLogger.debug({ args }, message);
  }
  info(message: string, ...args: unknown[]): void {
    appLogger.info({ args }, message);
  }
  warn(message: string, ...args: unknown[]): void {
    appLogger.warn({ args }, message);
  }
  error(message: string, ...args: unknown[]): void {
    appLogger.error({ args }, message);
  }
  success(message: string, ...args: unknown[]): void {
    appLogger.info({ args }, message);
  }
  log(level: LogLevel, message: string, ...args: unknown[]): void {
    appLogger.info({ level, args }, message);
  }
  setLevel(_level: LogLevel): void {
    /* managed by pino */
  }
  getLevel(): LogLevel {
    return LogLevel.Info;
  }
  createChild(_prefix: string): ILogger {
    return this;
  }
}

/**
 * Resolve the on-disk root where @salesforce/metadata-plugins ships its
 * prebuilt React bundles: {package-root}/dist/plugins. The framework looks
 * for {pluginId}/ui/ underneath this path.
 */
function resolvePluginReactBuildsBasePath(): string {
  const pkgJsonPath = require_.resolve('@salesforce/metadata-plugins/package.json');
  return path.join(path.dirname(pkgJsonPath), PLUGINS_DIST_DIR, PLUGINS_DIR);
}

/**
 * Resolve the on-disk directory of the core-sdk design-system module so we
 * can serve its `vscode-design-system.css` to the plugin iframe as
 * `platform.css`.
 */
function resolveCoreSdkDesignSystemDir(): string {
  const entry = require_.resolve('@salesforce/metadata-core-sdk/design-system');
  return path.dirname(entry);
}

class NodePlatformContext implements IPlatformContext {
  public readonly fileSystem: IFileSystem;
  public readonly logger: ILogger;
  public readonly telemetry: ITelemetry;
  public readonly reactBuildsBasePath: string;

  constructor(workspaceRoot: string) {
    this.fileSystem = new NodeFileSystem(workspaceRoot);
    this.logger = new NodeLogger();
    this.telemetry = new NoOpTelemetry();
    this.reactBuildsBasePath = resolvePluginReactBuildsBasePath();
  }
}

/**
 * Wraps the visualizer framework for one project. Owns a platform context,
 * plugin manager, and engine; serializes visualize() calls to protect the
 * framework's single-subscriber error manager slot.
 */
class ProjectVisualizationEngine {
  private readonly context: NodePlatformContext;
  private readonly pluginManager: PluginManager;
  private readonly engine: VisualizationEngine;
  private visualizeQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    context: NodePlatformContext,
    pluginManager: PluginManager,
    engine: VisualizationEngine
  ) {
    this.context = context;
    this.pluginManager = pluginManager;
    this.engine = engine;
  }

  static async create(projectDir: string): Promise<ProjectVisualizationEngine> {
    const context = new NodePlatformContext(projectDir);
    const pluginManager = new PluginManager(context);
    await pluginManager.loadPlugins();
    const engine = new VisualizationEngine(context, pluginManager);
    return new ProjectVisualizationEngine(context, pluginManager, engine);
  }

  listPlugins(): Array<{
    id: string;
    name: string;
    description?: string;
    author: string;
    filePatterns: string[];
    priority?: number;
  }> {
    return this.pluginManager.getAllVisualizerPlugins().map((p) => ({
      id: p.metadata.id,
      name: p.metadata.name,
      description: p.metadata.description,
      author: p.metadata.author,
      filePatterns: p.metadata.filePatterns,
      priority: p.metadata.priority,
    }));
  }

  hasPlugin(pluginId: string): boolean {
    return this.pluginManager.getAllVisualizerPlugins().some((p) => p.metadata.id === pluginId);
  }

  /**
   * Discover project files any registered plugin can handle. Walks each
   * plugin's filePatterns (suffix style, e.g. `.object-meta.xml`) and returns
   * {path, fileName, pluginId} for each match, forward-slashed and
   * deduplicated by path (first plugin wins — priority order is a framework
   * concern we don't re-implement here).
   */
  async listHandledFiles(
    projectDir: string
  ): Promise<Array<{ path: string; fileName: string; pluginId: string }>> {
    const plugins = this.pluginManager.getAllVisualizerPlugins();
    const byPath = new Map<string, { path: string; fileName: string; pluginId: string }>();

    for (const plugin of plugins) {
      for (const pattern of plugin.metadata.filePatterns) {
        const suffix = pattern.startsWith('*') ? pattern.slice(1) : pattern;
        const g = `**/*${suffix}`;
        const matches = await glob(g, {
          cwd: projectDir,
          nodir: true,
          absolute: false,
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
        });
        for (const rel of matches) {
          const normalized = rel.split(path.sep).join('/');
          if (!byPath.has(normalized)) {
            byPath.set(normalized, {
              path: normalized,
              fileName: path.posix.basename(normalized),
              pluginId: plugin.metadata.id,
            });
          }
        }
      }
    }

    return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Parse a project-relative metadata file and return the plugin's data.
   * Runs serialized — the framework's ErrorManager has a single-subscriber
   * slot that concurrent calls would trample.
   */
  async visualizeFile(
    projectDir: string,
    queryPath: string
  ): Promise<{ pluginId: string; data: unknown }> {
    const { absolute } = resolveProjectPath(queryPath, projectDir);

    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) {
        throw new NotAFileError(queryPath);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') throw new FileNotFoundError(queryPath);
      throw err;
    }

    if (!this.pluginManager.isSupportedFileForVisualization(absolute)) {
      throw new UnsupportedFileTypeError(queryPath);
    }

    return this.runSerialized(async () => {
      const errorManager = this.engine.getErrorManager();
      let captured: PluginError | null = null;
      errorManager.clearError();
      errorManager.setOnErrorReported((err) => {
        captured = err;
      });

      try {
        const result: VisualizationResult | null = await this.engine.visualize(absolute);
        if (!result) {
          const err = captured ?? errorManager.getError() ?? null;
          throw new VisualizationFailedError(
            err?.message ?? 'Visualization failed (plugin returned no result).',
            err
          );
        }
        return { pluginId: result.plugin.metadata.id, data: result.data };
      } finally {
        errorManager.setOnErrorReported(undefined);
      }
    });
  }

  dispose(): void {
    this.engine.getErrorManager().setOnErrorReported(undefined);
    this.engine.dispose();
  }

  private runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.visualizeQueue.then(task, task);
    this.visualizeQueue = next.catch(() => undefined);
    return next;
  }
}

/**
 * Bootstrap script injected into every plugin index.html. Defines
 * `window.__ExtensionHostPostMessage` which `HostCommunicationUtils` calls
 * internally; all messages are relayed to `window.parent`, which the host
 * (App Studio LWC, demo page, …) is responsible for mapping onto
 * `POST /visualize` and replying to.
 */
const BROWSER_BOOTSTRAP_SCRIPT = `
<script>
(function() {
  if (window.parent === window) {
    console.error('[browser-bootstrap] Not running inside a frame; __ExtensionHostPostMessage needs a parent window.');
    return;
  }
  Object.defineProperty(window, '__ExtensionHostPostMessage', {
    value: function(msg) { window.parent.postMessage(msg, '*'); },
    writable: false,
    configurable: false
  });
})();
</script>
`.trim();

export function injectBootstrap(html: string): string {
  if (html.includes('</head>')) {
    return html.replace('</head>', `${BROWSER_BOOTSTRAP_SCRIPT}\n</head>`);
  }
  if (html.includes('</body>')) {
    return html.replace('</body>', `${BROWSER_BOOTSTRAP_SCRIPT}\n</body>`);
  }
  return BROWSER_BOOTSTRAP_SCRIPT + html;
}

/**
 * Rewrite `@dist/...` placeholders in plugin HTML to this project's platform
 * route. Only use within a request where the project id is known.
 */
export function resolveDistPlaceholders(html: string, projectId: string): string {
  return html.replace(/@dist\//g, `/v1/projects/${projectId}/visualize/platform/`);
}

/**
 * Read and return a plugin's prebuilt index.html, transformed so the browser
 * can load it: `@dist/` placeholders rewritten, bootstrap script injected.
 */
export async function readPluginIndexHtml(
  engine: ProjectVisualizationEngine,
  pluginId: string,
  projectId: string
): Promise<string> {
  if (!engine.hasPlugin(pluginId)) {
    throw new PluginNotFoundError(pluginId);
  }
  const root = resolvePluginReactBuildsBasePath();
  const indexPath = path.join(root, pluginId, 'ui', 'index.html');
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    return injectBootstrap(resolveDistPlaceholders(raw, projectId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new PluginNotFoundError(pluginId);
    }
    throw err;
  }
}

/**
 * Resolve an asset path under a plugin's UI build dir, rejecting traversal
 * outside the `assets/` subtree. Returns the absolute path to read from, or
 * throws. The route's wildcard captures the path *after* `/assets/`, so we
 * re-anchor to the plugin's `ui/assets/` directory here.
 */
export function resolvePluginAssetPath(
  engine: ProjectVisualizationEngine,
  pluginId: string,
  assetPath: string
): string {
  if (!engine.hasPlugin(pluginId)) {
    throw new PluginNotFoundError(pluginId);
  }
  const root = resolvePluginReactBuildsBasePath();
  const assetsDir = path.join(root, pluginId, 'ui', 'assets');
  const decoded = decodeURIComponent(assetPath);
  const absolute = path.resolve(assetsDir, decoded);
  const rel = path.relative(assetsDir, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new FileNotFoundError(assetPath);
  }
  return absolute;
}

/** Absolute path to the core-sdk design-system CSS served as platform.css. */
export function getPlatformCssPath(): string {
  return path.join(resolveCoreSdkDesignSystemDir(), 'vscode-design-system.css');
}

export { ProjectVisualizationEngine };
