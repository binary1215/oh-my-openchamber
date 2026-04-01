# Runtime Host

## Purpose

`runtime-host` provides an OpenChamber-native, deterministic runtime host skeleton for task lifecycle orchestration.

- Owns in-memory runtime and task state
- Emits versioned `RuntimeEvent` envelopes
- Supports replay-friendly sequencing via injected clock and stable counters
- Keeps persistence as an explicit boundary (`load` / `save` / `append`)

## API

### `createRuntimeHost({ now, store, bus, runtimeID, instanceID, hostKind })`

Builds a runtime host with deterministic behavior.

- `now`: deterministic clock dependency (returns ISO string)
- `store`: persistence boundary (`load`, `save`, `append`)
- `bus`: event bus boundary (`subscribe`, `publish`)
- `runtimeID`, `instanceID`, `hostKind`: runtime identity

Returns:

- `getHostSnapshot()`
- `listTasks()`
- `getTask(taskID)`
- `enqueueTask(input)`
- `startTask(taskID)`
- `completeTask(taskID, output)`
- `cancelTask(taskID, reason?)`
- `retryTask(taskID)` (deterministic not-implemented error)
- `subscribe(listener)`

## Determinism and Replay

- IDs are monotonic counters (`task-0001`, `corr-0001`, `evt-0001`)
- Event ordering is deterministic (`payload.eventSequence`)
- Timestamps come only from injected `now()`
- Event envelopes are emitted through `createRuntimeEvent` (`runtime.event.v1`)

## Event Model

The host emits task lifecycle events with versioned envelopes:

- `task.enqueued`
- `task.started`
- `task.completed`
- `task.cancelled`

Each event payload includes:

- `eventID`
- `eventSequence`
- `correlationID`

## Persistence Boundary

The host persists a single snapshot and appends every emitted event:

- `load()` -> current snapshot
- `save(snapshot)` -> overwrite snapshot atomically
- `append(event)` -> append-only event log

Default implementation: `createInMemoryRuntimeHostStore()`

## Notes

This module intentionally does not include provider branching, OMO prompts/policy logic, or adapter-specific execution behavior.
