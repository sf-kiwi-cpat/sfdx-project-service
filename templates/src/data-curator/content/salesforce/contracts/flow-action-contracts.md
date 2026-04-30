# Flow Action Contracts

These are the Flow API names and contracts referenced by the Agent Script bundle.

The inventory, triage, ownership, remediation, and summary-generation Flows now exist in `force-app-flows/main/default/flows/` and are backed by invocable Apex classes in `force-app/main/default/classes/`.

## `Curator_Get_Metadata_Inventory`

- Type: Autolaunched Flow
- Backing Apex:
  - `DataCuratorGetMetadataInventoryAction`
- Inputs:
  - `department_filter` (`Text`)
  - `status_filter` (`Text`)
- Outputs:
  - `inventory_snapshot` (`Text Area Long`)
  - `department_filter_used` (`Text`)
  - `health_score` (`Number`)
  - `unassigned_count` (`Number`)
  - `stale_count` (`Number`)

## `Curator_Run_Stale_Metadata_Review`

- Type: Autolaunched Flow
- Backing Apex:
  - `DataCuratorRunStaleMetadataReviewAction`
- Inputs:
  - `department_filter` (`Text`)
  - `stale_threshold_days` (`Number`)
- Outputs:
  - `review_snapshot` (`Text Area Long`)
  - `stale_asset_count` (`Number`)
  - `critical_asset_count` (`Number`)

## `Curator_Propose_Metadata_Owner`

- Type: Autolaunched Flow
- Backing Apex:
  - `DataCuratorProposeMetadataOwnerAction`
- Inputs:
  - `asset_name` (`Text`)
  - `department_filter` (`Text`)
- Outputs:
  - `asset_name` (`Text`)
  - `recommended_owner_id` (`Text`)
  - `recommended_owner_name` (`Text`)
  - `reasoning_summary` (`Text Area Long`)

## `Curator_Assign_Metadata_Owner`

- Type: Autolaunched Flow
- Backing Apex:
  - `DataCuratorAssignMetadataOwnerAction`
- Inputs:
  - `asset_name` (`Text`)
  - `owner_user_id` (`Text`)
- Outputs:
  - `assignment_status` (`Text`)
  - `audit_record_id` (`Text`)

## `Curator_Build_Duplicate_Cleanup_Plan`

- Type: Autolaunched Flow
- Backing Apex:
  - `DataCuratorDuplicatePlanAction`
- Inputs:
  - `department_filter` (`Text`)
  - `confidence_threshold` (`Number`)
- Outputs:
  - `plan_summary` (`Text Area Long`)
  - `duplicate_cluster_count` (`Number`)
  - `projected_monthly_savings` (`Currency`)

## `Curator_Generate_Governance_Summary`

- Type: Autolaunched Flow
- Backing Apex:
  - `DataCuratorGovSummaryAction`
- Inputs:
  - `request_context` (`Text`)
  - `inventory_snapshot` (`Text Area Long`)
- Outputs:
  - `promptResponse` (`Text Area Long`)

## `Curator_Generate_Stale_Brief`

- Type: Autolaunched Flow
- Backing Apex:
  - `DataCuratorStaleBriefAction`
- Inputs:
  - `request_context` (`Text`)
  - `review_snapshot` (`Text Area Long`)
- Outputs:
  - `promptResponse` (`Text Area Long`)

## `Curator_Generate_Owner_Message`

- Type: Autolaunched Flow
- Backing Apex:
  - `DataCuratorOwnerNoteAction`
- Inputs:
  - `asset_name` (`Text`)
  - `request_context` (`Text`)
- Outputs:
  - `promptResponse` (`Text Area Long`)

## `Curator_Generate_Cleanup_Summary`

- Type: Autolaunched Flow
- Backing Apex:
  - `DataCuratorCleanupBriefAction`
- Inputs:
  - `request_context` (`Text`)
  - `plan_summary` (`Text Area Long`)
- Outputs:
  - `promptResponse` (`Text Area Long`)
