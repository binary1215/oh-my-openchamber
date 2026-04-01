# Tool Fabric

`tool-fabric` is a native runtime module that provides deterministic tool registration and invocation with approval and cancellation semantics.

## Public API

### `createToolRegistry({ tools })`

Builds an in-memory registry with metadata and execution handlers.

- `registerTool(tool)`
  - Required: `name`, `execute()`
  - Metadata: `permissionScope`, `timeoutPolicy.timeoutMs`, `resultSchema`, `requiresApproval`
- `getTool(name)` returns the normalized tool definition or `null`
- `listTools()` returns metadata only (no executable function)

### `createApprovalBridge()`

Tracks pending approvals and resolves deterministic decisions.

- `requestApproval({ taskID, invocationID, toolName, input })`
  - Returns `{ approvalID, decision, request }`
  - `decision` resolves to `{ approvalID, status, decidedAt, details }`
- `approve(approvalID, details)`
- `deny(approvalID, details)`
- `cancel(approvalID, reason)`
- `listPending()` returns currently pending requests

Decision actions are idempotent. Repeating `approve/deny/cancel` after terminal state returns `{ ok: false, status: 'noop' }`.

### `createToolDispatcher({ registry, approvalBridge, now, emitEvent, hasPermission })`

Dispatches tool invocations and emits versioned runtime events via `createRuntimeEvent`.

- `invokeTool({ taskID, toolName, input, requiresApproval })`
  - Returns `{ invocationID, invocation, result, cancel }`
  - `result` resolves to a structured terminal outcome:
    - success: `{ ok: true, status: 'completed', output, error: null }`
    - failure: `{ ok: false, status: 'failed', error }`
    - cancellation: `{ ok: false, status: 'cancelled', error }`
  - `cancel(reason)` is idempotent and emits exactly one terminal event.

## Runtime Events

`tool-fabric` emits these runtime event types:

- `tool.queued`
- `approval.requested`
- `approval.granted`
- `approval.denied`
- `tool.running`
- `tool.completed`
- `tool.failed`
- `tool.cancelled`

Each emitted event includes deterministic `payload.eventSequence` ordering and uses injected `now()` timestamps for deterministic testing.

## Errors

Structured errors use deterministic codes:

- `TOOL_FABRIC_TOOL_NOT_FOUND`
- `TOOL_FABRIC_EXECUTION_FAILED`
- `TOOL_FABRIC_TIMEOUT`
- `TOOL_FABRIC_CANCELLED`
- `TOOL_FABRIC_PERMISSION_DENIED`
- `TOOL_FABRIC_APPROVAL_DENIED`
