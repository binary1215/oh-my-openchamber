# OMO Kernel Inventory Map

This document captures the portable OMO behavioral kernel inventory derived from the Oh-My-OpenCode (OA) codebase. It is the human-readable companion to the data exported from `index.js`.

## Categories

- **portable**: specification-oriented or behavioral assets that can be reused across runtimes without OpenCode-native glue.
- **needs-native-adapter**: behavior that is required for the OMO experience but depends on OpenCode SDKs, tools, or UI runtimes.
- **drop**: non-portable glue, plugin surfaces, and CLI wiring that should not be treated as part of the portable kernel.

## Portable kernel entries (`PORTABLE`)

| Category | OA path or pattern |
|----------|--------------------|
| portable | `[OA]/docs/guide/orchestration.md` |
| portable | `[OA]/docs/reference/features.md` |
| portable | `[OA]/docs/examples/default.jsonc` |
| portable | `[OA]/docs/examples/planning-focused.jsonc` |
| portable | `[OA]/src/agents/atlas/agent.ts` |
| portable | `[OA]/src/agents/prometheus/**` |
| portable | `[OA]/src/agents/sisyphus-junior/**` |
| portable | `[OA]/src/agents/builtin-agents.ts` |
| portable | `[OA]/src/tools/delegate-task/constants.ts` |
| portable | `[OA]/src/tools/delegate-task/categories.ts` |
| portable | `[OA]/src/features/boulder-state/**` |
| portable | `[OA]/src/hooks/atlas/**` |
| portable | `[OA]/src/hooks/todo-continuation-enforcer/**` |
| portable | `[OA]/src/tools/session-manager/session-formatter.ts` |
| portable | `[OA]/src/tools/session-manager/types.ts` |

## Needs-native-adapter entries (`NEEDS_NATIVE_ADAPTER`)

| Category | OA path or pattern |
|----------|--------------------|
| needs-native-adapter | `[OA]/src/tools/delegate-task/tools.ts` |
| needs-native-adapter | `[OA]/src/tools/delegate-task/executor.ts` |
| needs-native-adapter | `[OA]/src/tools/delegate-task/prompt-builder.ts` |
| needs-native-adapter | `[OA]/src/tools/delegate-task/sync-continuation.ts` |
| needs-native-adapter | `[OA]/src/tools/delegate-task/background-continuation.ts` |
| needs-native-adapter | `[OA]/src/tools/delegate-task/*task*` |
| needs-native-adapter | `[OA]/src/tools/delegate-task/*poll*` |
| needs-native-adapter | `[OA]/src/tools/delegate-task/*prompt*` |
| needs-native-adapter | `[OA]/src/tools/call-omo-agent/tools.ts` |
| needs-native-adapter | `[OA]/src/tools/session-manager/tools.ts` |
| needs-native-adapter | `[OA]/src/features/background-agent/**` |
| needs-native-adapter | `[OA]/src/features/task-toast-manager/**` |
| needs-native-adapter | `[OA]/src/features/tool-metadata-store/**` |
| needs-native-adapter | `[OA]/src/hooks/start-work/start-work-hook.ts` |
| needs-native-adapter | `[OA]/src/plugin/hooks/create-continuation-hooks.ts` |

## Drop / non-portable glue entries (`DROP`)

| Category | OA path or pattern |
|----------|--------------------|
| drop | `[OA]/src/index.ts` |
| drop | `[OA]/src/plugin-interface.ts` |
| drop | `[OA]/src/plugin/types.ts` |
| drop | `[OA]/src/plugin-config.ts` |
| drop | `[OA]/src/shared/plugin-identity.ts` |
| drop | `[OA]/src/cli/**` |
| drop | `[OA]/src/cli/run/server-connection.ts` |
| drop | `[OA]/src/features/claude-code-*` |

The drop list explicitly includes CLI and plugin glue even when some internal helpers conceptually touch the kernel. These are intentionally excluded from the portable surface.

## Minimal vertical slice

The minimal end-to-end behavioral vertical slice is:

> Plan → `/start-work` → boulder configuration → Atlas prompt → `task()` execution → continuation (`executeSyncContinuation` / `executeBackgroundContinuation`) → idle hooks (`todo-continuation-enforcer` / `atlasHook`) re-trigger until done.

This slice is represented in `VERTICAL_SLICE_ENTRYPOINTS` in `index.js` using OA entrypoint identifiers from the scanned inventory:

- **plan / start-work**: `[OA]/src/hooks/start-work/start-work-hook.ts` (bridges the planning entrypoint to OpenCode runtime).
- **boulder configuration**: `[OA]/src/features/boulder-state/**` (persistent boulder state and configuration).
- **atlas prompt**: `[OA]/src/hooks/atlas/**` (Atlas prompt construction and orchestration helpers).
- **task execution**: `[OA]/src/agents/atlas/agent.ts`, `[OA]/src/agents/sisyphus-junior/**`, `[OA]/src/agents/prometheus/**` (agents participating in task execution).
- **continuation**: `[OA]/src/tools/delegate-task/sync-continuation.ts`, `[OA]/src/tools/delegate-task/background-continuation.ts` (continuation executors).
- **idle hooks**: `[OA]/src/hooks/todo-continuation-enforcer/**`, `[OA]/src/hooks/atlas/**` (idle-time hooks that re-trigger work until completion).

All identifiers above are also present as entries in the data exports from `index.js` to keep the mapping stable and machine-readable.
