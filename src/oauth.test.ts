import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateAuthorizationUrl,
  handleCallback,
  getSession,
  isAuthenticated,
  clearSession,
  refreshAccessToken,
  resetOAuthState,
} from './oauth.js';

const originalFetch = global.fetch;

describe('OAuth Service', () => {
  beforeEach(() => {
    resetOAuthState();
    process.env.SF_CLIENT_ID = 'test-client-id';
    process.env.SF_CLIENT_SECRET = 'test-client-secret';
    process.env.SF_CALLBACK_URL = 'http://localhost:3000/oauth/callback';
    process.env.SF_LOGIN_URL = 'https://login.salesforce.com';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.SF_CLIENT_ID;
    delete process.env.SF_CLIENT_SECRET;
    delete process.env.SF_CALLBACK_URL;
    delete process.env.SF_LOGIN_URL;
    resetOAuthState();
  });

  describe('generateAuthorizationUrl', () => {
    it('returns a well-formed authorization URL with all required parameters', () => {
      const url = generateAuthorizationUrl();

      expect(url).toContain('https://login.salesforce.com/services/oauth2/authorize');
      expect(url).toContain('response_type=code');
      expect(url).toContain('client_id=test-client-id');
      expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Foauth%2Fcallback');
      expect(url).toContain('scope=api+refresh_token');
      expect(url).toContain('state=');
      expect(url).toContain('code_challenge=');
      expect(url).toContain('code_challenge_method=S256');
    });

    it('throws when OAuth is not configured', () => {
      delete process.env.SF_CLIENT_ID;
      delete process.env.SF_CLIENT_SECRET;

      expect(() => generateAuthorizationUrl()).toThrow('OAuth is not configured');
    });

    it('generates unique state for each call', () => {
      const url1 = generateAuthorizationUrl();
      const url2 = generateAuthorizationUrl();

      const state1 = new URL(url1).searchParams.get('state');
      const state2 = new URL(url2).searchParams.get('state');

      expect(state1).not.toBe(state2);
      expect(state1).toBeDefined();
      expect(state2).toBeDefined();
    });

    it('generates a valid PKCE code challenge (base64url-encoded SHA-256)', () => {
      const url = generateAuthorizationUrl();
      const codeChallenge = new URL(url).searchParams.get('code_challenge');

      // Code challenge should be base64url (no padding)
      expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(codeChallenge).not.toContain('=');

      // Verify it's the right length for a SHA-256 hash (base64url = 43 chars)
      expect(codeChallenge?.length).toBe(43);
    });

    it('accepts custom loginUrl', () => {
      const url = generateAuthorizationUrl('https://test.salesforce.com');

      expect(url).toContain('https://test.salesforce.com/services/oauth2/authorize');
    });
  });

  describe('handleCallback', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
      global.fetch = mockFetch as unknown as typeof fetch;
    });

    it('rejects an unknown state', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      await expect(handleCallback('code', 'unknown-state')).rejects.toThrow(
        'Invalid or expired state parameter'
      );
    });

    it('rejects a reused state (one-time use)', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token1',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      // First use succeeds
      await handleCallback('code', state);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token2',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      // Second use fails
      await expect(handleCallback('code2', state)).rejects.toThrow(
        'Invalid or expired state parameter'
      );
    });

    it('exchanges code for tokens on success', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      const session = await handleCallback('test-code', state);

      expect(session.accessToken).toBe('test-access-token');
      expect(session.refreshToken).toBe('test-refresh-token');
      expect(session.instanceUrl).toBe('https://test.salesforce.com');
      expect(session.orgId).toBe('00Dxx0000000000');
      expect(session.userId).toBe('005xx000000000Z');
      expect(session.orgName).toBe('Test Org');
      expect(session.expiresAt).toBeDefined();
    });

    it('extracts orgId and userId from id URL', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000ABC/005xx000000XYZ1',
          token_type: 'Bearer',
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Org' }),
      });

      const session = await handleCallback('code', state);

      expect(session.orgId).toBe('00Dxx0000000ABC');
      expect(session.userId).toBe('005xx000000XYZ1');
    });

    it('handles missing org name gracefully (non-fatal)', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      // Org name fetch fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const session = await handleCallback('code', state);

      expect(session.orgName).toBeNull();
      expect(session.accessToken).toBe('token');
    });
  });

  describe('getSession', () => {
    it('returns null when no session exists', () => {
      const session = getSession();
      expect(session).toBeNull();
    });

    it('returns the stored session', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      const mockFetch = vi.fn();
      global.fetch = mockFetch as unknown as typeof fetch;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      const stored = await handleCallback('code', state);

      const retrieved = getSession();
      expect(retrieved).toEqual(stored);
    });
  });

  describe('isAuthenticated', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
      global.fetch = mockFetch as unknown as typeof fetch;
    });

    it('returns false when no session', () => {
      expect(isAuthenticated()).toBe(false);
    });

    it('returns true after successful callback', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      await handleCallback('code', state);

      expect(isAuthenticated()).toBe(true);
    });

    it('returns false when session is expired', async () => {
      vi.useFakeTimers();
      try {
        const authUrl = generateAuthorizationUrl();
        const state = new URL(authUrl).searchParams.get('state')!;

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'token',
            instance_url: 'https://test.salesforce.com',
            id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
            token_type: 'Bearer',
            expires_in: 1, // expires in 1 second
          }),
        });

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ Name: 'Test Org' }),
        });

        await handleCallback('code', state);

        // Advance time past expiration + 5-minute buffer
        vi.advanceTimersByTime(2000);

        expect(isAuthenticated()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('applies 5-minute buffer for expiration', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
          expires_in: 240, // 4 minutes
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      await handleCallback('code', state);

      // Should be false because expires in 4 min < 5 min buffer
      expect(isAuthenticated()).toBe(false);
    });
  });

  describe('clearSession', () => {
    it('clears the stored session', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      const mockFetch = vi.fn();
      global.fetch = mockFetch as unknown as typeof fetch;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      await handleCallback('code', state);
      expect(getSession()).not.toBeNull();

      clearSession();
      expect(getSession()).toBeNull();
    });
  });

  describe('refreshAccessToken', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
      global.fetch = mockFetch as unknown as typeof fetch;
    });

    it('updates the stored session with new access token', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'original-token',
          refresh_token: 'refresh-token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      await handleCallback('code', state);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      const session = await refreshAccessToken();

      expect(session.accessToken).toBe('new-token');
      expect(session.refreshToken).toBe('refresh-token'); // unchanged
    });

    it('clears session on refresh failure', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          refresh_token: 'refresh-token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      await handleCallback('code', state);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Invalid refresh token',
      });

      await expect(refreshAccessToken()).rejects.toThrow();
      expect(getSession()).toBeNull();
    });

    it('throws when no refresh token available', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
        // no refresh_token
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      await handleCallback('code', state);

      await expect(refreshAccessToken()).rejects.toThrow('No refresh token');
    });
  });

  describe('resetOAuthState', () => {
    it('clears session and pending states', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      const mockFetch = vi.fn();
      global.fetch = mockFetch as unknown as typeof fetch;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      await handleCallback('code', state);
      expect(getSession()).not.toBeNull();

      resetOAuthState();

      expect(getSession()).toBeNull();

      // Verify that the old state can't be reused
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      await expect(handleCallback('code', state)).rejects.toThrow();
    });
  });

  describe('validateExchangeTokenResponse', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
      global.fetch = mockFetch as unknown as typeof fetch;
    });

    it('accepts a valid token response with all required fields', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      const session = await handleCallback('code', state);
      expect(session.accessToken).toBe('token');
    });

    it('rejects response missing access_token', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      await expect(handleCallback('code', state)).rejects.toThrow(
        "Invalid token response: missing required field 'access_token'"
      );
    });

    it('rejects response missing instance_url', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      await expect(handleCallback('code', state)).rejects.toThrow(
        "Invalid token response: missing required field 'instance_url'"
      );
    });

    it('rejects response missing id', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          instance_url: 'https://test.salesforce.com',
          token_type: 'Bearer',
        }),
      });

      await expect(handleCallback('code', state)).rejects.toThrow(
        "Invalid token response: missing required field 'id'"
      );
    });

    it('rejects response missing token_type', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
        }),
      });

      await expect(handleCallback('code', state)).rejects.toThrow(
        "Invalid token response: missing required field 'token_type'"
      );
    });

    it('rejects response with wrong type for access_token', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 123, // wrong type
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      await expect(handleCallback('code', state)).rejects.toThrow(
        "Invalid token response: field 'access_token' must be a string"
      );
    });

    it('rejects non-object token response', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => 'not an object',
      });

      await expect(handleCallback('code', state)).rejects.toThrow(
        'Invalid token response: expected an object'
      );
    });

    it('rejects exchange response missing both instance_url and id', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          token_type: 'Bearer',
          // neither instance_url nor id - would have passed old heuristic
        }),
      });

      await expect(handleCallback('code', state)).rejects.toThrow(
        "Invalid token response: missing required field 'instance_url'"
      );
    });
  });

  describe('validateRefreshTokenResponse', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
      global.fetch = mockFetch as unknown as typeof fetch;
    });

    it('accepts refresh response with only access_token and token_type', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'original-token',
          refresh_token: 'refresh-token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      await handleCallback('code', state);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      const session = await refreshAccessToken();
      expect(session.accessToken).toBe('new-token');
    });

    it('rejects refresh response missing access_token', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          refresh_token: 'refresh-token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      await handleCallback('code', state);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token_type: 'Bearer',
        }),
      });

      await expect(refreshAccessToken()).rejects.toThrow(
        "Invalid token response: missing required field 'access_token'"
      );
    });

    it('rejects refresh response missing token_type', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          refresh_token: 'refresh-token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      await handleCallback('code', state);

      // Refresh with invalid response - missing token_type
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-token',
          // missing token_type
        }),
      });

      await expect(refreshAccessToken()).rejects.toThrow(
        "Invalid token response: missing required field 'token_type'"
      );
    });

    it('rejects refresh response with non-object', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          refresh_token: 'refresh-token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      await handleCallback('code', state);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => 'not an object',
      });

      await expect(refreshAccessToken()).rejects.toThrow(
        'Invalid token response: expected an object'
      );
    });

    it('rejects refresh response with wrong type for access_token', async () => {
      const authUrl = generateAuthorizationUrl();
      const state = new URL(authUrl).searchParams.get('state')!;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token',
          refresh_token: 'refresh-token',
          instance_url: 'https://test.salesforce.com',
          id: 'https://login.salesforce.com/id/00Dxx0000000000/005xx000000000Z',
          token_type: 'Bearer',
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Name: 'Test Org' }),
      });

      await handleCallback('code', state);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 123,
          token_type: 'Bearer',
        }),
      });

      await expect(refreshAccessToken()).rejects.toThrow(
        "Invalid token response: field 'access_token' must be a string"
      );
    });
  });
});
