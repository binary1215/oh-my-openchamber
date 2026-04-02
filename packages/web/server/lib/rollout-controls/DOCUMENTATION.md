# Rollout Controls Module Documentation

## Purpose
`rollout-controls` centralizes runtime transplant feature flags, failure-budget rollback triggers, and in-process metrics/tracing for operational guardrails.

## Entrypoints
- `packages/web/server/lib/rollout-controls/index.js`: env-backed rollout config resolver + runtime controller.

## Environment variables
- `OPENCHAMBER_RUNTIME_TRANSPLANT_ENABLED` (default: `true`)
- `OPENCHAMBER_RUNTIME_PROVIDER_ADAPTERS_ENABLED` (default: `true`)
- `OPENCHAMBER_RUNTIME_ADVANCED_OMO_ENABLED` (default: `true`)
- `OPENCHAMBER_RUNTIME_FAILURE_BUDGET_MAX_FAILURES` (default: `3`)
- `OPENCHAMBER_RUNTIME_ROLLBACK_ON_FAILURE_BUDGET` (default: `true`)

## Behavior summary
- Flags gate runtime transplant, provider adapters, and advanced OMO behavior independently.
- Failure budget is deterministic (counter-based only, no timing heuristics).
- Budget breach can trigger rollback kill-switch behavior that disables runtime transplant and advanced paths.
- Metrics/traces are kept in-process with explicit counters for model calls, tool calls, cancellations, retries, provider negotiation failures, and rollback activations.
