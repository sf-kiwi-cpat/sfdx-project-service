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
 * Unit coverage for the stateless credential-extraction helpers in
 * `src/utils/auth.ts`. These are pure functions operating on Fastify
 * request headers, so tests pass in a minimal request-shaped object
 * rather than spinning up the full app.
 */
import { describe, it, expect } from 'vitest';
import {
  extractCredentials,
  extractOptionalCredentials,
  validateCredentials,
} from '../../src/utils/auth.js';
import type { FastifyRequest } from 'fastify';

/** Build a minimal Fastify request-like shape with the given headers. */
function makeRequest(headers: Record<string, string | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe('utils/auth', () => {
  describe('validateCredentials', () => {
    it('returns valid when both accessToken and instanceUrl are valid', () => {
      const result = validateCredentials('token', 'https://example.my.salesforce.com');
      expect(result.valid).toBe(true);
    });

    it('rejects missing accessToken', () => {
      const result = validateCredentials(undefined, 'https://example.my.salesforce.com');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('accessToken');
      }
    });

    it('rejects empty accessToken', () => {
      const result = validateCredentials('', 'https://example.my.salesforce.com');
      expect(result.valid).toBe(false);
    });

    it('rejects non-string accessToken', () => {
      const result = validateCredentials(42, 'https://example.my.salesforce.com');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('accessToken');
      }
    });

    it('rejects missing instanceUrl', () => {
      const result = validateCredentials('token', undefined);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('instanceUrl');
      }
    });

    it('rejects non-string instanceUrl', () => {
      const result = validateCredentials('token', 12345);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('instanceUrl');
      }
    });

    it('rejects malformed instanceUrl', () => {
      const result = validateCredentials('token', 'not-a-url');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('valid URL');
      }
    });
  });

  describe('extractCredentials', () => {
    it('returns credentials when Bearer token + instance URL are both present', () => {
      const req = makeRequest({
        authorization: 'Bearer abc123',
        'x-salesforce-instance-url': 'https://example.my.salesforce.com',
      });
      const result = extractCredentials(req);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.credentials.accessToken).toBe('abc123');
        expect(result.credentials.instanceUrl).toBe('https://example.my.salesforce.com');
      }
    });

    it('fails when Authorization header is missing', () => {
      const req = makeRequest({
        'x-salesforce-instance-url': 'https://example.my.salesforce.com',
      });
      const result = extractCredentials(req);
      expect(result.valid).toBe(false);
    });

    it('fails when Authorization header is not Bearer', () => {
      const req = makeRequest({
        authorization: 'Basic abc123',
        'x-salesforce-instance-url': 'https://example.my.salesforce.com',
      });
      const result = extractCredentials(req);
      expect(result.valid).toBe(false);
    });

    it('fails when instance URL header is missing', () => {
      const req = makeRequest({
        authorization: 'Bearer abc123',
      });
      const result = extractCredentials(req);
      expect(result.valid).toBe(false);
    });

    it('fails when instance URL header is malformed', () => {
      const req = makeRequest({
        authorization: 'Bearer abc123',
        'x-salesforce-instance-url': 'not-a-url',
      });
      const result = extractCredentials(req);
      expect(result.valid).toBe(false);
    });
  });

  describe('extractOptionalCredentials', () => {
    it('returns credentials when both headers are present and well-formed', () => {
      const req = makeRequest({
        authorization: 'Bearer abc123',
        'x-salesforce-instance-url': 'https://example.my.salesforce.com',
      });
      const result = extractOptionalCredentials(req);
      expect(result).not.toBeNull();
      expect(result?.accessToken).toBe('abc123');
      expect(result?.instanceUrl).toBe('https://example.my.salesforce.com');
    });

    it('returns null when Authorization is missing', () => {
      const req = makeRequest({
        'x-salesforce-instance-url': 'https://example.my.salesforce.com',
      });
      expect(extractOptionalCredentials(req)).toBeNull();
    });

    it('returns null when Authorization is not Bearer', () => {
      const req = makeRequest({
        authorization: 'Token abc123',
        'x-salesforce-instance-url': 'https://example.my.salesforce.com',
      });
      expect(extractOptionalCredentials(req)).toBeNull();
    });

    it('returns null when instance URL header is missing', () => {
      const req = makeRequest({
        authorization: 'Bearer abc123',
      });
      expect(extractOptionalCredentials(req)).toBeNull();
    });

    it('returns null when instance URL is malformed', () => {
      const req = makeRequest({
        authorization: 'Bearer abc123',
        'x-salesforce-instance-url': 'not-a-url',
      });
      expect(extractOptionalCredentials(req)).toBeNull();
    });
  });
});
