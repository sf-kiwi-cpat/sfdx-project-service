# Salesforce Agentforce Starter

This repo includes an Agentforce starter implementation for the Data Curator app.

## Included

- `force-app/main/default/objects/`
  - Support objects for cataloged assets, scan runs, governance tasks, and auditable events
- `force-app-flows/main/default/flows/`
  - Autolaunched Flows that implement the action API names used by the agent bundle
- `force-app/main/default/classes/`
  - Apex service and invocable action classes used by the Flows
- `agentforce-prompts/main/default/genAiPromptTemplates/`
  - Prompt Builder metadata starter stubs that can be revisited later if you want native prompt-template deployment
- `agentforce-bundle/main/default/aiAuthoringBundles/DataCuratorAgent/`
  - Agent Script bundle with governance-focused topics backed by Flow actions
- `force-app/main/default/applications/Data_Curator.app-meta.xml`
  - Lightning app shell that surfaces the governance objects and standard admin tabs
- `force-app/main/default/permissionsets/Data_Curator_Admin.permissionset-meta.xml`
  - Admin access for the support objects and tabs
- `salesforce/contracts/flow-action-contracts.md`
  - Flow API names, required inputs, and expected outputs
- `salesforce/contracts/prompt-template-contracts.md`
  - Prompt Builder templates and input names expected by the agent

## Topics

- `executive_summary`
  - Builds a fresh inventory snapshot and generates a concise governance brief
- `stale_metadata_triage`
  - Reviews stale assets and drafts attestation or archival guidance
- `ownership_recovery`
  - Recommends owners, assigns owners, and drafts handoff messaging
- `duplicate_remediation`
  - Produces duplicate cluster plans and approval-ready cleanup summaries

## Recommended build sequence in your org

1. Create or model the metadata inventory data source the Flows will query.
2. Deploy the base metadata first with `manifest/package.xml` so the custom objects, fields, tabs, permission set, and Apex classes compile before Flow validation begins.
3. Deploy the autolaunched Flows second with `manifest/flows-package.xml`. This avoids the "can't find an action with the name and action type" error that can occur when invocable Apex actions aren't active yet.
4. Deploy the authoring bundle from `agentforce-bundle/main/default` or with `manifest/authoring-bundle-package.xml` after the Flows already exist.
5. If your Salesforce CLI exposes the newer authoring-bundle commands, validate the bundle locally; otherwise use Agentforce Builder to import and review the script.
6. Preview in simulated mode first, then preview in live mode once the Flows exist.
7. Publish the authoring bundle or recreate the topics and actions in Builder, depending on the CLI/plugin version available in your environment.
8. Treat `agentforce-prompts/main/default` as optional Prompt Builder scaffolding to deploy only after you confirm the prompt template type values your org currently accepts.

## Flow to Apex mapping

- `Curator_Get_Metadata_Inventory` -> `DataCuratorGetMetadataInventoryAction`
- `Curator_Run_Stale_Metadata_Review` -> `DataCuratorRunStaleMetadataReviewAction`
- `Curator_Propose_Metadata_Owner` -> `DataCuratorProposeMetadataOwnerAction`
- `Curator_Assign_Metadata_Owner` -> `DataCuratorAssignMetadataOwnerAction`
- `Curator_Build_Duplicate_Cleanup_Plan` -> `DataCuratorDuplicatePlanAction`
- `Curator_Generate_Governance_Summary` -> `DataCuratorGovSummaryAction`
- `Curator_Generate_Stale_Brief` -> `DataCuratorStaleBriefAction`
- `Curator_Generate_Owner_Message` -> `DataCuratorOwnerNoteAction`
- `Curator_Generate_Cleanup_Summary` -> `DataCuratorCleanupBriefAction`

## Tooling note

On March 23, 2026, the local CLI in this workspace reported `@salesforce/cli 2.108.6` and exposed `sf agent` plus `sf agent generate agent-spec|template|test-spec`, but not the newer authoring-bundle commands that appear in current Salesforce docs. Plan on one of these paths:

- upgrade the Salesforce agent tooling in your dev environment
- use Agentforce Builder for the final import and publication steps

## UI to agent mapping

- Dashboard: executive summaries, activity feed, ownership coverage
- Explorer: asset search, owner assignment, bulk remediation entry points
- Agent Command: natural-language front door to the same operations through topics and actions

## Support object model

- `Metadata_Asset__c`: object, field, flow, integration, or prompt asset under governance
- `Governance_Task__c`: work items created by scans, stewards, or the agent
- `Scan_Run__c`: execution records for scans and remediation analysis
- `Governance_Event__c`: audit trail for significant governance actions

## Prompt template note

The `GenAiPromptTemplate` files in this repo are based on current public examples, but prompt-template metadata remains org-sensitive. The deploy-safe path for this project uses flow-backed summary actions, while the prompt-template files remain optional scaffolding that you can reconcile with your org by creating and retrieving them through Prompt Builder.
