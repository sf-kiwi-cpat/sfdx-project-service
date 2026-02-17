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

/**
 * Allowed Salesforce login domains for OAuth loginUrl parameter.
 * Restricts to known Salesforce instances to prevent credential exfiltration.
 */
const ALLOWED_LOGIN_DOMAINS = [
  'login.salesforce.com',
  'test.salesforce.com',
  'sandbox.salesforce.com',
];

/**
 * Validate that a login URL is from a trusted Salesforce domain.
 * Returns true if the URL hostname is in the allowed list and uses HTTPS (except localhost).
 * Returns false otherwise.
 */
export function isValidLoginUrl(loginUrl: string | undefined): boolean {
  if (!loginUrl) return true; // undefined/empty is valid (uses config default)

  try {
    const url = new URL(loginUrl);
    const hostname = url.hostname.toLowerCase();
    const protocol = url.protocol.toLowerCase();

    // Localhost is allowed only for local development (http or https)
    if (hostname === 'localhost') {
      return true;
    }

    // Non-localhost must use HTTPS
    if (protocol !== 'https:') {
      return false;
    }

    // Check if hostname matches any allowed domain or is a subdomain
    return ALLOWED_LOGIN_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false; // invalid URL
  }
}
