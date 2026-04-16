---
stage: plan-lint
description: Pre-build validation — verify unit red tests fail against HEAD before entering build
tools: Read, Bash, Glob, Grep
---

# Plan Lint Stage

## Mission

Validate that each unit's backpressure tests fail against HEAD before the build
phase begins. A test that passes means either the feature already exists (and the
unit plan is stale) or the test is vacuous.

## Constraints

- **Mechanical stage.** Run via `scripts/plan-lint.ts`, not via AI executor.
- On pass: transition to build.
- On reject: transition back to decompose with specific feedback per failing unit.
