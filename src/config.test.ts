import { describe, it, expect } from 'vitest';
import { isValidLoginUrl } from './config.js';

describe('isValidLoginUrl', () => {
  it('returns true for undefined (uses config default)', () => {
    expect(isValidLoginUrl(undefined)).toBe(true);
  });

  it('returns true for empty string (uses config default)', () => {
    expect(isValidLoginUrl('')).toBe(true);
  });

  // Valid Salesforce domains
  it('returns true for https://login.salesforce.com', () => {
    expect(isValidLoginUrl('https://login.salesforce.com')).toBe(true);
  });

  it('returns true for https://test.salesforce.com', () => {
    expect(isValidLoginUrl('https://test.salesforce.com')).toBe(true);
  });

  it('returns true for https://sandbox.salesforce.com', () => {
    expect(isValidLoginUrl('https://sandbox.salesforce.com')).toBe(true);
  });

  // Valid subdomains of Salesforce domains
  it('returns true for https://custom.test.salesforce.com (subdomain)', () => {
    expect(isValidLoginUrl('https://custom.test.salesforce.com')).toBe(true);
  });

  it('returns true for https://sandbox-1.sandbox.salesforce.com (subdomain)', () => {
    expect(isValidLoginUrl('https://sandbox-1.sandbox.salesforce.com')).toBe(true);
  });

  // Localhost for local development
  it('returns true for http://localhost (local development)', () => {
    expect(isValidLoginUrl('http://localhost')).toBe(true);
  });

  it('returns true for http://localhost:3000 (local development with port)', () => {
    expect(isValidLoginUrl('http://localhost:3000')).toBe(true);
  });

  it('returns true for https://localhost (local development with HTTPS)', () => {
    expect(isValidLoginUrl('https://localhost')).toBe(true);
  });

  // Blocked: HTTP for non-localhost
  it('returns false for http://login.salesforce.com (not HTTPS)', () => {
    expect(isValidLoginUrl('http://login.salesforce.com')).toBe(false);
  });

  it('returns false for http://test.salesforce.com (not HTTPS)', () => {
    expect(isValidLoginUrl('http://test.salesforce.com')).toBe(false);
  });

  // Blocked: localhost subdomains
  it('returns false for http://evil.localhost (localhost subdomain)', () => {
    expect(isValidLoginUrl('http://evil.localhost')).toBe(false);
  });

  // Blocked: attacker-controlled domains
  it('returns false for https://evil.com', () => {
    expect(isValidLoginUrl('https://evil.com')).toBe(false);
  });

  it('returns false for https://salesforce.com (root domain, not allowed)', () => {
    expect(isValidLoginUrl('https://salesforce.com')).toBe(false);
  });

  it('returns false for https://evil.salesforce.com.attacker.com (domain suffix, not subdomain)', () => {
    expect(isValidLoginUrl('https://evil.salesforce.com.attacker.com')).toBe(false);
  });

  // Blocked: invalid URLs
  it('returns false for invalid URL', () => {
    expect(isValidLoginUrl('not a url')).toBe(false);
  });

  it('returns false for javascript protocol', () => {
    expect(isValidLoginUrl('javascript:alert(1)')).toBe(false);
  });

  it('returns false for file protocol', () => {
    expect(isValidLoginUrl('file:///etc/passwd')).toBe(false);
  });

  // Case insensitivity
  it('returns true for https://LOGIN.SALESFORCE.COM (uppercase)', () => {
    expect(isValidLoginUrl('https://LOGIN.SALESFORCE.COM')).toBe(true);
  });

  it('returns true for https://Test.Salesforce.Com (mixed case)', () => {
    expect(isValidLoginUrl('https://Test.Salesforce.Com')).toBe(true);
  });
});
