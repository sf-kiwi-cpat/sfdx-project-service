import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { getOAuthConfig, isOAuthConfigured, isValidLoginUrl } from './config.js';
import { logger } from './logger.js';
import { OAuthError } from './errors.js';

/**
 * OAuth session after successful authentication.
 */
export interface OAuthSession {
  accessToken: string;
  refreshToken: string | null;
  instanceUrl: string;
  issuedAt: number;       // epoch ms
  expiresAt: number | null; // epoch ms
  userId: string | null;
  orgId: string | null;
  orgName: string | null;
}

/**
 * Salesforce token response from OAuth token endpoint.
 */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
  id: string; // format: https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z
  token_type: string;
  expires_in?: number;
}

/**
 * Module-level state for pending authorization requests.
 * Maps state → { codeVerifier, createdAt } with TTL-based cleanup.
 */
interface PendingState {
  codeVerifier: string;
  createdAt: number;
}
const pendingStates = new Map<string, PendingState>();

// Clean up expired pending states every 60 seconds (10-minute TTL)
const PENDING_STATE_TTL = 10 * 60 * 1000; // 10 minutes
const CLEANUP_INTERVAL = 60 * 1000; // 60 seconds
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [state, { createdAt }] of pendingStates.entries()) {
    if (now - createdAt > PENDING_STATE_TTL) {
      pendingStates.delete(state);
    }
  }
}, CLEANUP_INTERVAL);
cleanupTimer.unref();

/**
 * Module-level storage for the current OAuth session.
 */
let currentSession: OAuthSession | null = null;

/**
 * Generate a PKCE code verifier: 32 random bytes, base64url-encoded.
 */
function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Generate a PKCE code challenge: SHA-256 hash of verifier, base64url-encoded.
 */
function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Extract orgId and userId from the id URL.
 * Format: https://login.salesforce.com/id/{orgId}/{userId}
 */
function parseIdUrl(idUrl: string): { orgId: string; userId: string } {
  const parts = idUrl.split('/');
  const userId = parts[parts.length - 1];
  const orgId = parts[parts.length - 2];

  if (!orgId || !userId) {
    throw new OAuthError(`Failed to parse id URL: ${idUrl}`);
  }

  return { orgId, userId };
}

/**
 * Fetch organization name via Salesforce REST API (non-fatal if fails).
 */
async function fetchOrgName(accessToken: string, instanceUrl: string, orgId: string): Promise<string | null> {
  try {
    const url = `${instanceUrl}/services/data/v62.0/sobjects/Organization/${orgId}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      logger.debug({ status: response.status }, 'Failed to fetch org name');
      return null;
    }

    const data = (await response.json()) as { Name?: string };
    return data.Name ?? null;
  } catch (err) {
    logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Error fetching org name');
    return null;
  }
}

/**
 * Exchange authorization code for tokens.
 * Private function used internally by handleCallback.
 */
async function exchangeCodeForTokens(code: string, codeVerifier: string, loginUrl?: string): Promise<TokenResponse> {
  const config = getOAuthConfig();
  const tokenUrl = `${loginUrl ?? config.loginUrl}/services/oauth2/token`;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.callbackUrl,
    code_verifier: codeVerifier,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.debug({ status: response.status, error: errorText }, 'Token exchange failed');
    throw new OAuthError(`Token exchange failed (HTTP ${response.status})`);
  }

  return (await response.json()) as TokenResponse;
}

/**
 * Generate the Salesforce OAuth authorization URL.
 * Returns the URL for the caller to open in a browser.
 * Throws if OAuth is not configured.
 */
export function generateAuthorizationUrl(loginUrl?: string): string {
  if (!isOAuthConfigured()) {
    throw new OAuthError('OAuth is not configured. Set SF_CLIENT_ID and SF_CLIENT_SECRET environment variables.');
  }

  if (!isValidLoginUrl(loginUrl)) {
    throw new OAuthError('Invalid loginUrl: must be a trusted Salesforce domain (e.g., login.salesforce.com, test.salesforce.com)');
  }

  const config = getOAuthConfig();
  const state = randomUUID();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Store state → { codeVerifier, createdAt } for later verification in handleCallback
  pendingStates.set(state, { codeVerifier, createdAt: Date.now() });

  const authUrl = new URL(`${loginUrl ?? config.loginUrl}/services/oauth2/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', config.callbackUrl);
  authUrl.searchParams.set('scope', config.scopes);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return authUrl.toString();
}

/**
 * Handle the OAuth callback from Salesforce.
 * Exchanges authorization code for tokens and stores the session.
 */
export async function handleCallback(code: string, state: string, loginUrl?: string): Promise<OAuthSession> {
  // Validate loginUrl before processing callback
  if (!isValidLoginUrl(loginUrl)) {
    throw new OAuthError('Invalid loginUrl: must be a trusted Salesforce domain (e.g., login.salesforce.com, test.salesforce.com)');
  }

  // Validate state (one-time use, must not be expired)
  const pending = pendingStates.get(state);
  if (!pending) {
    throw new OAuthError('Invalid or expired state parameter');
  }

  const now = Date.now();
  if (now - pending.createdAt > PENDING_STATE_TTL) {
    pendingStates.delete(state);
    throw new OAuthError('Invalid or expired state parameter');
  }

  const { codeVerifier } = pending;
  pendingStates.delete(state);

  // Exchange code for tokens
  const tokenResponse = await exchangeCodeForTokens(code, codeVerifier, loginUrl);

  // Parse org and user IDs from the id URL
  const { orgId, userId } = parseIdUrl(tokenResponse.id);

  // Fetch org name (non-fatal if it fails)
  const orgName = await fetchOrgName(tokenResponse.access_token, tokenResponse.instance_url, orgId);

  // Create and store session
  const session: OAuthSession = {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? null,
    instanceUrl: tokenResponse.instance_url,
    issuedAt: Date.now(),
    expiresAt: tokenResponse.expires_in !== undefined ? Date.now() + tokenResponse.expires_in * 1000 : null,
    userId,
    orgId,
    orgName,
  };

  currentSession = session;

  logger.info({ orgId, userId }, 'OAuth session established');

  return session;
}

/**
 * Get the current OAuth session (shallow copy), or null if not authenticated.
 * Returns a snapshot to prevent accidental mutation of internal state.
 */
export function getSession(): OAuthSession | null {
  return currentSession ? { ...currentSession } : null;
}

/**
 * Check if the current session is valid and not expired (with 5-minute buffer).
 */
export function isAuthenticated(): boolean {
  if (!currentSession) {
    return false;
  }

  if (!currentSession.expiresAt) {
    // No expiration info, assume valid
    return true;
  }

  const buffer = 5 * 60 * 1000; // 5 minutes
  return Date.now() < currentSession.expiresAt - buffer;
}

/**
 * Clear the current OAuth session (logout).
 */
export function clearSession(): void {
  currentSession = null;
  logger.info('OAuth session cleared');
}

/**
 * Refresh the access token using the refresh token.
 * Updates the stored session with the new token.
 */
export async function refreshAccessToken(): Promise<OAuthSession> {
  if (!currentSession || !currentSession.refreshToken) {
    throw new OAuthError('No refresh token available');
  }

  try {
    const config = getOAuthConfig();
    const tokenUrl = `${currentSession.instanceUrl}/services/oauth2/token`;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: currentSession.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn({ status: response.status }, 'Token refresh failed');
      logger.debug({ status: response.status, error: errorText }, 'Token refresh error details');
      clearSession();
      throw new OAuthError(`Token refresh failed (HTTP ${response.status})`);
    }

    const tokenResponse = (await response.json()) as TokenResponse;

    currentSession.accessToken = tokenResponse.access_token;
    currentSession.issuedAt = Date.now();
    currentSession.expiresAt = tokenResponse.expires_in !== undefined ? Date.now() + tokenResponse.expires_in * 1000 : null;

    logger.info('Access token refreshed');

    return { ...currentSession };
  } catch (err) {
    // clearSession already called in error path above, just re-throw
    throw err;
  }
}

/**
 * Reset OAuth state for testing.
 * Clears pending states and session.
 */
export function resetOAuthState(): void {
  pendingStates.clear();
  currentSession = null;
}
