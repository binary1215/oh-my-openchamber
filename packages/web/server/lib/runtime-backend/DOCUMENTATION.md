# Runtime Backend Module Documentation

## Purpose
`runtime-backend` wires runtime host APIs into the web backend surface without duplicating OpenCode provider/auth settings.

## Entrypoints
- `packages/web/server/lib/runtime-backend/index.js`: service factory that composes host lifecycle, persistence, policy, provider negotiation, and tool dispatch.
- `packages/web/server/lib/opencode/runtime-routes.js`: HTTP endpoints under `/api/opencode/runtime/*`.

## Composition boundaries
- **runtime-host**: task lifecycle state (`enqueue`, `start`, `cancel`, `complete`) and runtime event bus subscription.
- **runtime-persistence**: async snapshot/event append, attached as fire-and-forget persistence behind in-memory host state.
- **omo-policy**: `create-session` generates policy decisions (`decideNextAction`) to keep next-action semantics typed.
- **tool-fabric**: `run-task` supports approval + cancellation flow via `createToolDispatcher` and `createApprovalBridge`.
- **provider-adapters + contracts**: provider negotiation uses `normalizeCapabilityMatrix()` + `negotiateProviderCapabilities()` and returns typed `outcome/missing/degraded` fields.

## Runtime endpoints
- `POST /api/opencode/runtime/create-session`
- `POST /api/opencode/runtime/run-task`
- `POST /api/opencode/runtime/cancel-task`
- `POST /api/opencode/runtime/provider-negotiate`
- `GET /api/opencode/runtime/subscribe-events` (SSE)
- `GET /api/opencode/runtime/artifacts/:category/:fileName` (read-only)

## SSE payload contract
`subscribe-events` emits OpenChamber SSE blocks in the shared convention:

`data: {"type":"...","properties":{...}}\n\n`

The route streams runtime-host and backend-published events and removes listeners on client disconnect (`req.on('close', ...)`).
