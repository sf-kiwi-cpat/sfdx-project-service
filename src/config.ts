import path from 'node:path';

/**
 * Project root - where the SFDX project lives. Defaults to cwd; can be overridden via env for EFS mount.
 * Read at call time to support test isolation.
 */
export function getProjectPath(): string {
  return process.env.PROJECT_ROOT ?? process.cwd();
}

/**
 * Path to the default package directory (force-app/main/default).
 */
export function getDefaultPackagePath(): string {
  return path.join(getProjectPath(), 'force-app', 'main', 'default');
}

/**
 * Salesforce API version used for REST API calls and source metadata.
 * Format: '62.0' (no 'v' prefix - add 'v' at URL construction sites)
 */
export const SF_API_VERSION = '62.0';
