<!-- AUTO-GENERATED from contract.spec.ts — do not edit manually -->
<!-- Regenerate with: /cdd-spec --refresh health -->

# Health Check Endpoint Contract

Issue: [#71](https://github.com/forcedotcom/sfdx-project-service/issues/71)

## Endpoints

### GET `/health`

Liveness check for the internal reverse proxy. Confirms the Fastify HTTP
server is up and responding. No authentication required, no side effects,
no deep dependency checks.

**200 OK**
- returns 200 OK
- returns JSON with `{ status: "ok" }`
- responds without authentication

### HEAD `/health`

**200 OK**
- supports HEAD requests (liveness probes may use HEAD instead of GET)

### Method exclusivity

**404**
- rejects POST with 404
- rejects PUT with 404

**Routing**
- is not behind the `/v1` prefix (`GET /v1/health` returns 404)

## Design Principles

- **Liveness only** — no database, no external service checks
- **Unauthenticated** — internal to the container, no auth headers needed
- **Fast** — must respond quickly and never block
- **Root-level** — mounted at `/health`, not under the versioned API prefix
- **GET and HEAD only** — other HTTP methods are rejected

## Summary

- 1 endpoint: `GET /health` (also supports HEAD)
- 7 contract tests
