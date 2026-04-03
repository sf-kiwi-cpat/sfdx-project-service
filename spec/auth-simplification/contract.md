<!-- Auto-generated from contract.spec.ts — do not edit manually -->
<!-- Regenerate with: /cdd-spec --refresh auth-simplification -->

# Auth Simplification Contract

**Issue:** #163 — Simplify auth: accept optional orgAlias instead of instance/url credentials

**Auth resolution priority:**
1. Project-level `target-org` (from `.sf/config.json`, set via `orgAlias` at creation)
2. Global default org (from SFDX global config)
3. Legacy credential headers (`Authorization` + `X-Salesforce-Instance-Url`)
4. 400 if none available

This is **backward compatible** — existing credential-header auth continues
to work as a fallback.

---

## POST `/v1/projects` — orgAlias support

### 201

- returns 201 with `targetOrg` when `orgAlias` is provided
- persists `target-org` in project `.sf/config.json`
- returns 201 without `targetOrg` when `orgAlias` is omitted

### 400

- returns 400 when `orgAlias` is an empty string
- returns 400 when `orgAlias` is not found in auth store

---

## POST `/v1/projects/:id/deployments` — environment auth

### Environment auth (new path)

**202**

- returns 202 when project has `target-org` configured
- returns 202 using global default org when no `target-org`

### Credential headers (legacy fallback)

**202**

- returns 202 with credential headers when no environment auth

### Auth resolution priority

**202**

- prefers project target-org over credential headers when both present
- prefers global default org over credential headers when both present

### Error cases

**400**

- returns 400 when no auth is available (no env, no headers)

**502**

- returns 502 when resolved environment org auth fails

---

2 endpoints, 12 tests
