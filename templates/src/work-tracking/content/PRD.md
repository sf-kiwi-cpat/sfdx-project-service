# Work Tracking

## Overview

A lightweight task and work item tracker built on Salesforce custom objects.
Teams can create, assign, and track work items with validation rules that
enforce process — all running natively on the platform.

## Problem

Teams working inside Salesforce need a simple way to track tasks tied to their
org — config changes, data fixes, feature requests from business users —
without leaving the platform or spinning up a separate project management tool.

## Solution

A React app backed by Salesforce custom objects and fields that provides a
clean, focused interface for managing work items.

### Core Features

- **Work item CRUD** — Create, view, update, and close work items. Each item
  has a title, description, assignee, priority (Low / Medium / High / Critical),
  and status (Open / In Progress / Blocked / Done).
- **Custom object backbone** — Work items stored as Salesforce custom objects
  with custom fields for all properties. Leverages platform security, sharing,
  and audit trail for free.
- **Validation rules** — Enforce process guardrails. Examples: require a
  description before moving to In Progress, prevent closing without a
  resolution note, block Critical items from being unassigned.
- **Filtered views** — Quick filters by status, assignee, and priority. See
  "My Open Items" or "All Blocked" in one click.
- **Activity timeline** — Each work item shows a history of status changes
  and updates so nothing falls through the cracks.

### Non-Goals

- Sprint planning or velocity tracking
- Cross-object relationships (epics, projects)
- Gantt charts or timeline views

## Target Users

Small teams and individual contributors who need a straightforward way to
track work inside their Salesforce org without external tooling.
