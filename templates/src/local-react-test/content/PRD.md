# Pulse — Deployment Activity Dashboard

## Overview

Pulse is a real-time deployment activity dashboard for Salesforce orgs. It gives
developers and admins a live feed of what's happening across their metadata
deployments — deploys, component syncs, builds, and more — at a glance.

## Problem

Salesforce deployments happen constantly across teams, but there's no lightweight
way to see deployment activity in real time without opening Setup or digging
through CLI output. Teams want a heads-up display they can keep open while
working.

## Solution

A single-page React app that surfaces deployment activity as a live,
auto-refreshing feed with key stats.

### Core Features

- **Stats bar** — Running counts for total deploys, components touched, and
  org uptime percentage. Updates in real time.
- **Activity feed** — Scrolling list of recent deployment actions. Each entry
  shows a status indicator (success, pending, error), the action taken
  (Deployed, Created, Updated, Synced, Built), the metadata target
  (Apex class, Lightning component, Flow, etc.), and how long ago it happened.
- **Auto-refresh** — New activity appears every few seconds with smooth
  slide-in animations. No manual refresh needed.
- **Dark theme** — Designed for ambient monitoring. Low-glare dark UI with
  green accent for success states.

### Non-Goals

- Historical analytics or charting
- Deployment triggering or rollback
- Multi-org switching (single org view)

## Target Users

Developers and release managers who want passive visibility into org deployment
health while they work.
