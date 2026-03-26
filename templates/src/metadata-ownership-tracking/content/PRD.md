# Metadata Ownership Tracking

## Overview

A tool for tracking who owns what metadata across Salesforce orgs. Surfaces
ownership gaps, stale components, and cross-team dependencies so teams can
manage their metadata sprawl.

## Problem

As orgs grow, metadata accumulates — custom objects, flows, Apex classes,
validation rules — and nobody knows who owns what. When something breaks,
teams waste time figuring out who to ask. Unused metadata piles up because
nobody feels responsible for cleaning it up.

## Solution

A React-based dashboard that maps metadata components to owners and surfaces
actionable insights.

### Core Features

- **Ownership registry** — Assign owners (individuals or teams) to any metadata
  component. Bulk assign by prefix, type, or namespace.
- **Coverage dashboard** — See what percentage of metadata has an assigned
  owner. Highlight unowned components that need adoption.
- **Staleness detection** — Flag metadata that hasn't been modified in a
  configurable period. Surface candidates for cleanup or archival.
- **Dependency view** — Show which components reference others across team
  boundaries. Know when your change might break someone else's flow.
- **Change feed** — Recent modifications to tracked components with owner
  attribution. See who changed what and when.

### Non-Goals

- Deploying or modifying metadata (read-only tracking)
- Org-to-org comparison
- Full DevOps pipeline management

## Target Users

Platform teams, Salesforce architects, and release managers responsible for
metadata governance across large or multi-team orgs.
