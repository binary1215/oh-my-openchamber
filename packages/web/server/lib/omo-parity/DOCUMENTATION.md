# OMO Parity Module Documentation

## Purpose
`omo-parity` runs deterministic runtime parity scenarios against OpenChamber runtime modules using golden JSON fixtures.

## Entrypoints
- `packages/web/server/lib/omo-parity/index.js`: parity harness with `createOmoParityHarness(...)` and `runOmoParityScenario(...)`.
- `packages/web/server/lib/omo-parity/omo-parity.test.js`: Bun golden-suite tests that execute real runtime modules.

## Covered runtime inputs
- `runtime-contracts`: capability negotiation and event envelope shape checks.
- `omo-inventory`: vertical-slice entrypoint parity checks.
- `runtime-host`: deterministic task lifecycle + cancellation events.
- `runtime-persistence`: replay recovery verification.
- `omo-policy`: planner/delegation/continuation decisions.
- `provider-conformance`: capability matrix as provider truth source.
- `provider-adapters`: OpenAI-compatible, LiteLLM, and Ollama request path parity.
- `tool-fabric`: deterministic tool invocation envelopes.
- `runtime-backend`: provider degradation execution path through backend composition.

## Fixture contract
Fixtures live under `packages/web/server/lib/omo-parity/fixtures/*.json` and include:
- `scenario`: stable scenario ID.
- `type`: harness execution mode.
- `expected`: shaped assertions compared deterministically.

Current fixture coverage includes planner flow, delegation, continuation, tool execution, cancellation, replay recovery, provider degradation, and provider regression matrix.

## Determinism rules
- Harness time is fixed through a deterministic `now()` generator.
- Assertions compare shaped envelopes (`type`, `taskID`, `providerID`, `eventSequence`) instead of volatile full objects.
- Provider degradation checks fail explicitly when expected capability loss (`missingCapabilities` / `degradedCapabilities`) diverges.
