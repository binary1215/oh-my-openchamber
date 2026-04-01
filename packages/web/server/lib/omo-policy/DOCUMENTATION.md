# OMO Policy Module Documentation

## Purpose
This module rehosts the portable OMO behavioral kernel as a pure, versioned policy layer. It keeps prompts, delegation rules, continuation semantics, stop conditions, and handoff summary generation auditable and rollbackable without changing runtime host plumbing.

## Entrypoints and structure
- `packages/web/server/lib/omo-policy/index.js`: Versioned policy pack constants, policy engine factory, deterministic action decision logic, and handoff summary builder.
- `packages/web/server/lib/omo-policy/fixtures/*.json`: Golden scenario inputs/expected outputs for deterministic behavior checks.
- `packages/web/server/lib/omo-policy/omo-policy.test.js`: Bun golden tests for planning/delegation, deterministic stop guardrails, and handoff summary shape.

## Versioning strategy
- Policy pack version: `omo.policy.v1`
- Handoff summary version: `omo.handoff.v1`
- Runtime integration should treat these values as explicit contracts to support future `*.v2` additions safely.

## Public API
- `POLICY_PACK_VERSION`
- `DEFAULT_OMO_POLICY_PACK`
- `createOmoPolicyEngine({ now, policyPack })`
- `buildHandoffSummary({ taskState, recentEvents, now })`

`createOmoPolicyEngine` returns `decideNextAction(input)` where `input` includes task state and recent runtime events. The decision output is deterministic with stable action and step identifiers.

## Behavioral guarantees
- Planner/executor/reviewer prompt assets are policy data, not transport/runtime code.
- Delegation loop behavior is driven by rule tables and explicit stop conditions.
- Stop conditions are deterministic and explicit (`guardrail_event`, iteration cap, no-progress cap, terminal phases, manual stop).
- Handoff summaries use a stable schema with sorted identifiers and deterministic narrative output.

## Guardrails
- No imports from OpenCode plugin, CLI, or server lifecycle modules.
- No provider-specific branching.
- No randomness; deterministic IDs and `now()` injection are required.
