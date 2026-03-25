<!-- Auto-generated from contract.spec.ts — do not edit manually -->

# GET /templates

## Endpoints

### GET `/v1/templates`

**200**
- returns 200 with an array of template objects
- each template has id, name, and description fields
- lists the hello-world-1 and hello-world-2 templates

## Response Shape

```json
[
  {
    "id": "string",
    "name": "string",
    "description": "string (non-empty)"
  }
]
```

## Summary

1 describe block, 3 tests
