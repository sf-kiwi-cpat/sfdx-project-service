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
 * OAuth configuration — read at call time for test isolation.
 */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  loginUrl: string;
  scopes: string;
}

export function getOAuthConfig(): OAuthConfig {
  return {
    clientId: process.env.SF_CLIENT_ID ?? '',
    clientSecret: process.env.SF_CLIENT_SECRET ?? '',
    callbackUrl: process.env.SF_CALLBACK_URL ?? `http://localhost:${process.env.PORT ?? '3000'}/oauth/callback`,
    loginUrl: process.env.SF_LOGIN_URL ?? 'https://login.salesforce.com',
    scopes: process.env.SF_SCOPES ?? 'api refresh_token',
  };
}

/**
 * Check if OAuth is configured (has both client ID and secret).
 */
export function isOAuthConfigured(): boolean {
  const { clientId, clientSecret } = getOAuthConfig();
  return clientId !== '' && clientSecret !== '';
}
