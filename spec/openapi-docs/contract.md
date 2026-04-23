<!--
  AUTO-GENERATED from contract.spec.ts. DO NOT EDIT BY HAND.
  Regenerate with /cdd-spec --refresh openapi-docs after editing the spec.
-->

# OpenAPI Document Completeness — Contract

## Purpose

The OpenAPI document served at `/openapi.json` (and rendered by Swagger
UI at `/docs`) is a consumer-facing surface. Both human developers and
AI coding assistants read it to build correct clients against this API.
Thin docs cause consumers to hallucinate shapes — a real incident where
an AI assistant invented a `name` field on `POST /v1/projects` because
the `GET` response included one motivated this contract.

This contract pins **structural completeness** of the emitted OpenAPI
document, not prose. It never asserts specific summary or description
text — only that every route declares what a consumer needs.

## Endpoints introspected

- `GET /openapi.json` — emits the OpenAPI JSON document
- `GET /docs/` — renders the Swagger UI

## Design principles

- **Structural, not prose.** The contract asserts the presence and
  non-emptiness of fields. Wording is free to evolve without breaking
  the contract.
- **Dynamic enumeration.** The "every operation" invariants iterate
  over `paths` × HTTP methods. Any new route automatically inherits
  the invariants — you cannot ship an undocumented endpoint.
- **Exact success codes.** Success-code invariants pin the exact code
  each route returns today (201 for `POST /projects`, 202 for
  `POST /deployments`, 200 for reads). Accidental code changes break
  the contract rather than slipping through.
- **Schemas must be concrete.** Every declared response schema must
  declare either a `$ref` or a `type`. An empty `{}` satisfies the
  letter of "has a schema" but conveys nothing — this closes that
  loophole without pinning shape.
- **Non-JSON content types are pinned where they matter.** When a
  route intentionally returns something other than JSON
  (`text/plain`, `text/event-stream`), the content type is pinned so
  it cannot be silently re-documented as JSON.
- **Error responses must match reality.** The service serves every
  4xx error as `application/problem+json` per RFC 9457. The contract
  requires the OpenAPI doc to advertise that same media type, so
  consumers build error handling against what the service actually
  returns.
- **Dual failure reporting.** Per-invariant checks collect all
  offending operations into a single assertion so a missing tag on
  one route produces one clear failure listing every offender, not a
  cascade.

## Document-level metadata

### `GET /openapi.json`

**200**
- serves the OpenAPI JSON at /openapi.json with a valid OpenAPI 3.x document

### `GET /docs/`

**200**
- serves the Swagger UI at /docs

### Document fields
- declares a non-empty `info.description`
- declares at least one document-level tag with a description

## Every operation

Applies to every (path, HTTP method) pair in `paths`.

- has a non-empty `summary`
- has a non-empty `description`
- declares at least one tag, and every tag is registered at the document level
- declares a `description` on every response
- declares a `description` on every parameter
- declares a `description` on every top-level request body property

## Success response codes (exact code per route)

Each route must declare the exact success code it returns today, and
that response must declare a content type and a schema with either a
`$ref` or a `type`.

| Method | Path                                                          | Code |
| ------ | ------------------------------------------------------------- | ---- |
| GET    | `/v1/templates`                                               | 200  |
| POST   | `/v1/projects`                                                | 201  |
| GET    | `/v1/projects`                                                | 200  |
| PATCH  | `/v1/projects/{id}`                                           | 200  |
| GET    | `/v1/projects/{id}/file`                                      | 200  |
| GET    | `/v1/projects/{id}/tree`                                      | 200  |
| POST   | `/v1/projects/{id}/deployments`                               | 202  |
| GET    | `/v1/projects/{id}/deployments/{deploymentId}/events`         | 200  |
| GET    | `/v1/projects/{id}/fs/events`                                 | 200  |

## Non-JSON content types

Routes that intentionally return something other than JSON pin their
content type so it cannot be silently re-documented as JSON.

| Method | Path                                                          | Code | Content type        |
| ------ | ------------------------------------------------------------- | ---- | ------------------- |
| GET    | `/v1/projects/{id}/file`                                      | 200  | `text/plain`        |
| GET    | `/v1/projects/{id}/deployments/{deploymentId}/events`         | 200  | `text/event-stream` |
| GET    | `/v1/projects/{id}/fs/events`                                 | 200  | `text/event-stream` |

## Documented error responses

### `POST /v1/projects/{id}/deployments`

**400**
- declared when no authentication is available

### `GET /v1/projects/{id}/deployments/{deploymentId}/events`

**404**
- declared when the deployment id is unknown

### `PATCH /v1/projects/{id}`

**400**
- declared when the `name` body field is missing or invalid

### Routes that resolve a project id

The following routes must all declare a `404` response for unknown project ids:

- `PATCH /v1/projects/{id}`
- `GET /v1/projects/{id}/file`
- `GET /v1/projects/{id}/tree`
- `POST /v1/projects/{id}/deployments`
- `GET /v1/projects/{id}/deployments/{deploymentId}/events`
- `GET /v1/projects/{id}/fs/events`

## Error response shape (RFC 9457 `problem+json`)

The service uniformly serves errors as `application/problem+json` per
`src/errors.ts` (`PROBLEM_JSON`, `problemDetail`). The OpenAPI doc
must advertise the same media type.

- `components.schemas` declares at least one reusable schema whose
  properties include `status`, `title`, and `detail` (matching the
  RFC 9457 shape produced by `problemDetail()`). The schema name is
  not pinned — any schema with those fields counts.
- Every documented `4xx` response on every operation declares
  `application/problem+json` as a content type, with a schema that
  declares either a `$ref` or a `type`.

## Authentication

The deploy route accepts two credential headers:

- `Authorization: Bearer <accessToken>` — modeled as an OpenAPI
  `http` / `bearer` security scheme.
- `X-Salesforce-Instance-Url: <url>` — modeled as a required header
  parameter (since OpenAPI security schemes cannot express a
  "bearer + companion header" combination cleanly).

### Assertions
- `components.securitySchemes` declares at least one `http` / `bearer` scheme
- `POST /v1/projects/{id}/deployments` references that bearer scheme in its `security` array
- `POST /v1/projects/{id}/deployments` declares the `X-Salesforce-Instance-Url` header parameter with a non-empty description

## Summary

- 1 document-level section (4 assertions)
- 6 every-operation invariants
- 9 success-code assertions (one per route)
- 3 non-JSON content-type assertions (1 text/plain + 2 text/event-stream)
- 4 error-response presence assertions
- 2 error-response shape assertions (RFC 9457 problem+json)
- 3 authentication assertions
