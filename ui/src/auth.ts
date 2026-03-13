import type { Credentials } from './types';

// ---------------------------------------------------------------------------
// In-memory credential storage (never persisted to disk / localStorage)
// ---------------------------------------------------------------------------

let credentials: Credentials | null = null;

export function getCredentials(): Credentials | null {
  return credentials;
}

export function setCredentials(creds: Credentials): void {
  credentials = creds;
}

export function clearCredentials(): void {
  credentials = null;
}

// ---------------------------------------------------------------------------
// OAuth 2.0 PKCE helpers
// ---------------------------------------------------------------------------

/**
 * Generate a random code verifier (43-128 chars, unreserved URI characters).
 */
function generateCodeVerifier(): string {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Derive the S256 code challenge from a code verifier.
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Session-scoped storage for the PKCE verifier so the callback can use it.
const VERIFIER_KEY = 'sf_pkce_verifier';
const INSTANCE_URL_KEY = 'sf_instance_url';

/**
 * Kick off the OAuth Authorization Code + PKCE flow by redirecting the
 * browser to the Salesforce authorize endpoint.
 */
export async function startLogin(instanceUrl: string, clientId: string): Promise<void> {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);

  // Store verifier + instanceUrl in sessionStorage so the callback page can
  // retrieve them.  sessionStorage is tab-scoped and cleared when the tab
  // closes, so this is acceptable for a demo.
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(INSTANCE_URL_KEY, instanceUrl);

  const redirectUri = `${window.location.origin}/callback`;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  window.location.href = `${instanceUrl}/services/oauth2/authorize?${params.toString()}`;
}

/**
 * Complete the OAuth flow by exchanging the authorization code for an access
 * token.  Called from the Callback page.
 */
export async function exchangeCodeForToken(code: string, clientId: string): Promise<Credentials> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const instanceUrl = sessionStorage.getItem(INSTANCE_URL_KEY);

  if (!verifier || !instanceUrl) {
    throw new Error('Missing PKCE verifier or instance URL. Please log in again.');
  }

  // Clean up sessionStorage
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(INSTANCE_URL_KEY);

  const redirectUri = `${window.location.origin}/callback`;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  const response = await fetch(`${instanceUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${text}`);
  }

  const data = await response.json();

  const creds: Credentials = {
    accessToken: data.access_token,
    instanceUrl,
  };

  setCredentials(creds);
  return creds;
}
