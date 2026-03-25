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

import { FastifyRequest } from 'fastify';

/**
 * Org credentials for Salesforce authentication.
 * These are passed as HTTP headers on each request (stateless).
 */
export interface OrgCredentials {
  accessToken: string;
  instanceUrl: string;
}

/**
 * Extract and validate org credentials from request headers.
 *
 * Expected headers:
 * - Authorization: Bearer <accessToken>
 * - X-Salesforce-Instance-Url: <instanceUrl>
 *
 * Returns validation result with error message if invalid.
 */
export function extractCredentials(
  request: FastifyRequest
): { valid: false; error: string } | { valid: true; credentials: OrgCredentials } {
  // Extract access token from Authorization header
  const authHeader = request.headers.authorization as string | undefined;
  const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  // Extract instance URL from custom header
  const instanceUrl = request.headers['x-salesforce-instance-url'] as string | undefined;

  // Validate credentials
  const validation = validateCredentials(accessToken, instanceUrl);
  if (!validation.valid) {
    return validation;
  }

  return {
    valid: true,
    credentials: {
      accessToken: accessToken!,
      instanceUrl: instanceUrl!,
    },
  };
}

/**
 * Validate credentials format.
 * - accessToken: required string
 * - instanceUrl: required, must be valid URL
 */
export function validateCredentials(
  accessToken?: unknown,
  instanceUrl?: unknown
): { valid: false; error: string } | { valid: true } {
  if (!accessToken || typeof accessToken !== 'string') {
    return {
      valid: false,
      error:
        'accessToken is required and must be a string (provide via Authorization: Bearer <token> header)',
    };
  }
  if (!instanceUrl || typeof instanceUrl !== 'string') {
    return {
      valid: false,
      error:
        'instanceUrl is required and must be a string (provide via X-Salesforce-Instance-Url header)',
    };
  }

  // Validate instanceUrl is a valid URL
  try {
    new URL(instanceUrl);
  } catch {
    return { valid: false, error: 'instanceUrl must be a valid URL' };
  }

  return { valid: true };
}
