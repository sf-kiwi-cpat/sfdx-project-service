# Prompt Template Contracts

These prompt templates are referenced by the agent via `generatePromptResponse://<DeveloperName>`.

## `Curator_Governance_Summary`

- Inputs:
  - `Input:request_context`
  - `Input:inventory_snapshot`
- Expected output:
  - `promptResponse`
- Purpose:
  - Produce an executive-ready summary of metadata health with a single recommended next action.

## `Curator_Stale_Metadata_Brief`

- Inputs:
  - `Input:request_context`
  - `Input:inventory_snapshot`
- Expected output:
  - `promptResponse`
- Purpose:
  - Summarize stale metadata risk and recommend re-attestation or archival pathways.

## `Curator_Owner_Outreach`

- Inputs:
  - `Input:asset_name`
  - `Input:request_context`
- Expected output:
  - `promptResponse`
- Purpose:
  - Draft a crisp stewardship handoff message for a newly assigned owner.

## `Curator_Duplicate_Cleanup_Summary`

- Inputs:
  - `Input:request_context`
  - `Input:inventory_snapshot`
- Expected output:
  - `promptResponse`
- Purpose:
  - Turn a duplicate cleanup plan into an approval-ready summary with risk callouts.

