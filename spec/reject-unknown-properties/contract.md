<!-- AUTO-GENERATED from contract.spec.ts — do not edit manually -->

# Reject Unknown Request Body Properties

## Overview

The API rejects request bodies that contain properties not defined in the
route's body schema. Returning a 400 Bad Request surfaces caller mistakes
(typos, wrong field names, unsupported options) immediately instead of
silently dropping the unknown property and returning success.

**Motivation (from issue #178):** a consumer posted
`{ "name": "my-project", "template": "minimal" }` to `POST /v1/projects`
expecting `name` to set the project name. The request returned 201 with
an auto-generated name, and the problem was only discovered later when
`GET /v1/projects` reported the generated value. Under this contract the
same request returns 400 naming `name` as the offending property.

## Scope

- Applies to every endpoint that declares (or must declare) a body schema.
- Body-accepting endpoints covered by this contract:
  - `POST /v1/projects` — already declares a body schema today.
  - `PATCH /v1/projects/:id` — does **not** yet declare a body schema.
    It validates `name` imperatively inside the handler. Satisfying this
    contract requires the implementation to add a body schema to PATCH
    so Ajv can enforce `additionalProperties: false`.
- Endpoints that do not declare a body schema (e.g. the deployments POST)
  are out of scope. This contract governs schema-validated bodies, not
  whether a route should have a schema — the PATCH clarification above
  is the one exception, because this contract forces PATCH to gain a
  schema as part of adoption.

## Error Response

All 400 responses follow the project's existing RFC 9457 problem-detail
shape and are served as `application/problem+json`:

```json
{
  "status": 400,
  "title": "Bad Request",
  "detail": "body must NOT have additional properties: 'name'"
}
```

- `status` is `400`.
- `title` is `"Bad Request"`.
- `detail` is a human-readable string that **includes the name of the
  offending property** so callers can identify the typo without
  consulting a schema.

## Endpoints

### POST `/v1/projects`

**400**
- Returns 400 when the body contains an unknown property alongside a known one
  (e.g. `{ template: 'local-react-test', name: 'my-project' }`). The `detail`
  includes the quoted property name (`'name'`) and schema-validation
  boilerplate (`additional` or `unknown`).
- Returns 400 when the body contains only a coined unknown property
  (e.g. `{ sproingyWidget: 'value' }`). The `detail` includes the
  property name (`sproingyWidget`) and schema-validation boilerplate.
- No project is created as a side effect of a rejected request —
  `GET /v1/projects` after a rejected POST still returns the empty list.

**201**
- Continues to accept a valid body with only known properties
  (`{ template: 'local-react-test' }`).
- Continues to accept an empty body (`{}`).

### PATCH `/v1/projects/:id`

**400**
- Returns 400 when the body contains an unknown property alongside `name`
  (e.g. `{ name: 'renamed', extraField: 'value' }`). The `detail` includes
  the offending property name (`extraField`).
- Returns 400 naming the unknown property when the body contains only an
  unknown property and no `name` (e.g. `{ wrongField: 'x' }`). The
  `additionalProperties` check fires before the "name is required" check,
  so the `detail` names the unknown property (`wrongField`), not `name`.
- No rename is performed as a side effect of a rejected request — the
  project's name is unchanged in `GET /v1/projects` after a rejected PATCH.

**200**
- Continues to accept a valid body with only the `name` property
  (`{ name: 'valid-rename' }`).

## Design Principles

- **Fail loudly, not silently.** Unknown properties are almost always a
  caller mistake. Surfacing them at the edge (400) is cheaper to debug
  than the downstream confusion of a "successful" no-op.
- **Strict by default.** New endpoints that declare a body schema must
  reject unknown properties without opting in; a global validator
  configuration is preferable to per-route settings so the default is
  safe.
- **No partial effects.** A request that is rejected for having unknown
  properties produces no observable state change.
- **Consistent error shape.** Reuses the project's existing RFC 9457
  problem-detail response with `application/problem+json`; no new error
  format is introduced.
