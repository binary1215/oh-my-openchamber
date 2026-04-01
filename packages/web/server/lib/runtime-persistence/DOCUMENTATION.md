# runtime-persistence

## Purpose

`runtime-persistence` defines explicit persistence boundaries for runtime-host state, deterministic replay from recorded runtime events, and OpenChamber-owned artifact storage path helpers.

## APIs

### `createRuntimePersistenceStore(...)`

Disk-backed store contract compatible with `runtime-host`:

- `load()` -> returns snapshot object or `null`
- `save(snapshot)` -> writes a versioned snapshot record
- `append(event)` -> appends a versioned event record to NDJSON log
- `getEvents()` -> returns ordered events from the append-only log

Record versions:

- Snapshot record: `runtime.persistence.snapshot.v1`
- Event record: `runtime.persistence.event-record.v1`

Runtime-specific storage location:

- `<baseDirectory>/runtime/<runtimeID>/runtime-snapshot.json`
- `<baseDirectory>/runtime/<runtimeID>/runtime-events.ndjson`

`baseDirectory` defaults to `~/.sisyphus` (OpenChamber-owned), never `.opencode`.

### `replayRuntimeEvents(events)`

Deterministically reconstructs runtime state from `RuntimeEvent[]` with no provider/network access.

Replay validation guarantees:

- All events use `runtime.event.v1`
- All events share one `runtimeID`
- `payload.eventSequence` is present, integer, and strictly contiguous (`1..N`)
- Task transitions are valid (`queued -> running -> completed|failed`, `queued|running -> cancelled`)

On corruption/out-of-order/malformed transitions, replay throws `RuntimeReplayError` with typed `code`:

- `RUNTIME_REPLAY_MALFORMED_EVENT`
- `RUNTIME_REPLAY_INVALID_ORDER`
- `RUNTIME_REPLAY_RUNTIME_MISMATCH`
- `RUNTIME_REPLAY_INVALID_TRANSITION`

No partial state is returned on error.

### `createRuntimeArtifactStore(...)`

Resolves and enforces artifact storage boundaries under a single base directory.

Artifact categories:

- `evidence` -> `<base>/evidence/`
- `plans` -> `<base>/plans/`
- `handoffs` -> `<base>/handoffs/`

Helpers:

- `resolveArtifactPath(category, fileName)`
- `writeArtifact(category, fileName, content)`
- `readArtifact(category, fileName)`

Path traversal is blocked: `fileName` must be a basename (no directory segments).
