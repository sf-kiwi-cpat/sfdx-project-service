<!-- Auto-generated from contract.spec.ts — do not edit manually -->

# GET /templates — Contract

## Overview

Lists all available project templates. Each template includes an identifier,
a human-readable display name, and a description for presentation to clients.

## Endpoints

### GET `/v1/templates`

**200 OK** — returns an array of template objects

| Field         | Type   | Constraints                       |
| ------------- | ------ | --------------------------------- |
| `id`          | string | unique template identifier        |
| `name`        | string | human-readable display name       |
| `description` | string | non-empty, describes the template |

## Behaviors

1. **Returns 200 with an array of template objects**
   - Response body is a non-empty array
   - At least one template is always available

2. **Each template has id, name, and description fields**
   - All three fields are present on every template object
   - All three fields are strings
   - `description` must be non-empty (length > 0)

3. **Known templates are listed**
   - `local-react-test` is always present (by `id`)

## Error Cases

None specified — the endpoint always returns 200 with the full template list.

## Summary

1 describe block (`GET /templates`), 3 tests
