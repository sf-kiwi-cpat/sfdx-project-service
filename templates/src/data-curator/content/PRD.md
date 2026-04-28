# Data Curator

## Overview

An agent-driven metadata governance app for Salesforce admins. Combines a
React dashboard, custom objects, autolaunched Flows, and Agentforce actions
to track metadata ownership, surface stale components, plan duplicate
cleanup, and let admins drive remediation through natural-language prompts.

## Problem

Admins are accountable for keeping org metadata healthy — knowing who owns
each custom object, flow, and report; finding stale assets; consolidating
duplicates — but the work is manual, cross-functional, and easy to defer.
Existing tooling reports on symptoms without helping admins act on them,
and there is no shared workspace where ownership, health, and remediation
tasks live together.

## Solution

A React-based governance workspace backed by custom objects and Flow-driven
Agentforce actions. Admins see the org's posture at a glance, drill into
specific assets, assign owners, generate briefs, and run remediation — all
from a single surface that an Agentforce agent can also drive on their
behalf.

### Core Features

- **Governance dashboard** — Health score, ownership coverage, stale-asset
  counts, and duplicate-cluster totals across the org, scoped by department
  when needed.
- **Metadata explorer** — Searchable, filterable inventory of
  `Metadata_Asset__c` records with owner, status, risk, and staleness in
  one view. Bulk assign owners, create tasks, or mark-healthy in one pass.
- **Task queue** — `Governance_Task__c` records tied to assets, with
  priority, due date, recommended action, and agent-suggested flag.
- **Scan runs** — `Scan_Run__c` captures each inventory sweep with totals
  for assets scanned, stale count, duplicate clusters, and unassigned
  count.
- **Event log** — `Governance_Event__c` audits every scan, assignment,
  proposal, export, and bulk action for traceability.
- **Agent command surface** — Agentforce chat panel invokes the
  `DataCuratorAgent` authoring bundle. The agent calls autolaunched Flows
  to run inventory scans, propose and assign owners, generate stale-metadata
  briefs, build duplicate-cleanup plans, and draft owner-outreach messages.
- **Reports** — Generated governance summaries, stale-metadata briefs,
  duplicate-cleanup plans, and owner outreach drafts, each backed by a
  dedicated Apex action and Flow.
- **Export + audit** — CSV/PDF exports with every download logged as a
  governance event.

### Non-Goals

- Read-only metadata monitoring (this app writes — assigns owners, creates
  tasks, records events)
- Full DevOps pipeline management (deploys, source control, release trains)
- Direct mutation of platform metadata (custom fields, object definitions);
  Data Curator governs custom `__c` records about those assets, not the
  assets themselves

## Target Users

Salesforce admins, platform teams, and release managers responsible for
metadata hygiene in large or multi-team orgs. Secondary users include
delivery leads who need ownership reports and executives who want a
governance posture summary.

## Architecture

- **React UI** served as a Salesforce `WebApplication`. Auto-detects host:
  uses `/services/apexrest/data-curator/v1` when running inside Salesforce,
  falls back to a local Express bridge (`server/index.mjs`) in dev.
- **Apex REST resources** (`DataCuratorGovernanceRestApi`,
  `DataCuratorAgentRestApi`) wrap a shared `DataCuratorGovernanceService`
  that owns the business logic and is covered by `*ServiceTest` /
  `*RestApiTest` classes.
- **Invocable Apex actions** (`DataCurator*Action`) expose governance
  operations as Flow-invocable actions.
- **Autolaunched Flows** orchestrate each agent-callable action
  (assign owner, propose owner, run stale review, build duplicate-cleanup
  plan, generate briefs and summaries).
- **Agentforce authoring bundle** (`DataCuratorAgent`) binds the Flows to
  an agent the React app can converse with via the Agent API.
- **Prompt template stubs** (`agentforce-prompts/`) are optional scaffolds
  for teams that want to move to native Prompt Builder templates later.

## Deployment order

1. `manifest/package.xml` — objects, Apex, tabs, app, permission set, and
   the `WebApplication`.
2. `manifest/flows-package.xml` — Flows (deploy after Apex so invocable
   action references resolve).
3. `agentforce-bundle/main/default` — Agentforce authoring bundle (depends
   on Flows).
4. Optional: `manifest/prompts-package.xml` — Prompt Builder scaffolds.
