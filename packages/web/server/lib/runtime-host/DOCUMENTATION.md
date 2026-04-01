# Runtime Host

## Purpose


untime-host provides an OpenChamber-native, deterministic runtime host skeleton for task lifecycle orchestration.

- Owns in-memory runtime + task state
- Emits versioned RuntimeEvent envelopes
- Supports replay-friendly sequencing via injected clock and stable counters
- Keeps persistence as an explicit boundary (load / save / ppend)

## API

### createRuntimeHost({ now, store, bus, runtimeID, instanceID, hostKind })

Builds a runtime host with deterministic behavior.

- 
ow: required deterministic clock dependency (returns ISO string)
- store: persistence boundary (load, save, ppend)
- us: event bus boundary (subscribe, publish)
- 
untimeID, instanceID, hostKind: runtime identity

Returns:

- getHostSnapshot()
- listTasks()
- getTask(taskID)
- enqueueTask(input)
- startTask(taskID)
- completeTask(taskID, output)
- cancelTask(taskID, reason?)
- 
etryTask(taskID) (deterministic not-implemented error)
- subscribe(listener)

## Determinism and Replay

- IDs are monotonic counters (	ask-0001, corr-0001, evt-0001)
- Event ordering is deterministic (payload.eventSequence)
- Timestamps come only from injected 
ow()
- Event envelopes are emitted through createRuntimeEvent (
untime.event.v1)

## Event Model

The host emits task lifecycle events with versioned envelopes:

- 	ask.enqueued
- 	ask.started
- 	ask.completed
- 	ask.cancelled

Each event payload includes:

- eventID
- eventSequence
- correlationID

## Persistence Boundary

The host persists a single snapshot and appends every emitted event:

- load() -> current snapshot
- save(snapshot) -> overwrite snapshot atomically
- ppend(event) -> append-only event log

Default implementation: createInMemoryRuntimeHostStore()

## Notes

This module intentionally does not include provider branching, OMO prompts/policy logic, or adapter-specific execution behavior.
