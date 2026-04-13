<!-- Auto-generated from contract.spec.ts — do not edit manually -->

# GET /templates — Contract

## Overview

Lists all available project templates. Each template includes an identifier,
a human-readable display name, a description, and category tags for
presentation to clients. Templates marked as not visible (e.g. test fixtures)
are excluded from the listing.

## Endpoints

### GET `/v1/templates`

**200 OK** — returns an array of template objects

| Field         | Type     | Constraints                       |
| ------------- | -------- | --------------------------------- |
| `id`          | string   | unique template identifier        |
| `name`        | string   | human-readable display name       |
| `description` | string   | non-empty, describes the template |
| `categories`  | string[] | category tags for the template    |

## Behaviors

1. **Returns 200 with an array of template objects**
   - Response body is a non-empty array
   - At least one template is always available

2. **Each template has id, name, description, and categories fields**
   - All four fields are present on every template object
   - `id`, `name`, `description` are strings
   - `description` must be non-empty (length > 0)
   - `categories` is an array

3. **Excludes templates with visible: false**
   - Templates with `"visible": false` in their `template.json` are not returned
   - `local-react-test` (a test fixture) is excluded from the listing

## Error Cases

None specified — the endpoint always returns 200 with the full template list.

## Summary

1 describe block (`GET /templates`), 3 tests
