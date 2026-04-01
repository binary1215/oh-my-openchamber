/**
 * OMO behavioral kernel inventory for Oh-My-OpenCode (OA).
 *
 * This module is data-only and classifies OA kernel assets into
 * portable, needs-native-adapter, and drop categories. Paths are
 * opaque identifiers prefixed with `[OA]/` and are not resolved at
 * runtime. The goal is to give OpenChamber a stable, reusable
 * inventory for future transplant work without requiring OA to be
 * checked out locally.
 */

/** @typedef {'portable' | 'needs-native-adapter' | 'drop'} OmoKernelCategory */

/**
 * @typedef OmoKernelEntry
 * @property {string} id
 * @property {OmoKernelCategory} category
 * @property {string} path
 */

/**
 * Canonical kernel entries derived from the OA scan results.
 * The IDs are stable keys that can be used by downstream tools.
 *
 * @type {ReadonlyArray<OmoKernelEntry>}
 */
export const OMO_KERNEL_ENTRIES = Object.freeze([
  // Portable docs and examples
  { id: 'docs-orchestration-guide', category: 'portable', path: '[OA]/docs/guide/orchestration.md' },
  { id: 'docs-features-reference', category: 'portable', path: '[OA]/docs/reference/features.md' },
  { id: 'docs-default-config-example', category: 'portable', path: '[OA]/docs/examples/default.jsonc' },
  { id: 'docs-planning-focused-example', category: 'portable', path: '[OA]/docs/examples/planning-focused.jsonc' },

  // Portable agents and specs
  { id: 'agent-atlas', category: 'portable', path: '[OA]/src/agents/atlas/agent.ts' },
  { id: 'agent-prometheus', category: 'portable', path: '[OA]/src/agents/prometheus/**' },
  { id: 'agent-sisyphus-junior', category: 'portable', path: '[OA]/src/agents/sisyphus-junior/**' },
  { id: 'agent-builtin-registry', category: 'portable', path: '[OA]/src/agents/builtin-agents.ts' },

  // Portable delegate task specs
  { id: 'delegate-task-constants', category: 'portable', path: '[OA]/src/tools/delegate-task/constants.ts' },
  { id: 'delegate-task-categories', category: 'portable', path: '[OA]/src/tools/delegate-task/categories.ts' },

  // Portable state and hooks
  { id: 'boulder-state', category: 'portable', path: '[OA]/src/features/boulder-state/**' },
  { id: 'atlas-hooks', category: 'portable', path: '[OA]/src/hooks/atlas/**' },
  { id: 'todo-continuation-enforcer-hooks', category: 'portable', path: '[OA]/src/hooks/todo-continuation-enforcer/**' },

  // Portable session manager specs
  { id: 'session-manager-formatter', category: 'portable', path: '[OA]/src/tools/session-manager/session-formatter.ts' },
  { id: 'session-manager-types', category: 'portable', path: '[OA]/src/tools/session-manager/types.ts' },

  // Needs-native-adapter: delegate-task runtime behavior
  { id: 'delegate-task-tools', category: 'needs-native-adapter', path: '[OA]/src/tools/delegate-task/tools.ts' },
  { id: 'delegate-task-executor', category: 'needs-native-adapter', path: '[OA]/src/tools/delegate-task/executor.ts' },
  { id: 'delegate-task-prompt-builder', category: 'needs-native-adapter', path: '[OA]/src/tools/delegate-task/prompt-builder.ts' },
  { id: 'delegate-task-sync-continuation', category: 'needs-native-adapter', path: '[OA]/src/tools/delegate-task/sync-continuation.ts' },
  { id: 'delegate-task-background-continuation', category: 'needs-native-adapter', path: '[OA]/src/tools/delegate-task/background-continuation.ts' },
  { id: 'delegate-task-task-helpers', category: 'needs-native-adapter', path: '[OA]/src/tools/delegate-task/*task*' },
  { id: 'delegate-task-poll-helpers', category: 'needs-native-adapter', path: '[OA]/src/tools/delegate-task/*poll*' },
  { id: 'delegate-task-prompt-helpers', category: 'needs-native-adapter', path: '[OA]/src/tools/delegate-task/*prompt*' },

  // Needs-native-adapter: tools and features that bind to OpenCode
  { id: 'call-omo-agent-tools', category: 'needs-native-adapter', path: '[OA]/src/tools/call-omo-agent/tools.ts' },
  { id: 'session-manager-tools', category: 'needs-native-adapter', path: '[OA]/src/tools/session-manager/tools.ts' },
  { id: 'background-agent-feature', category: 'needs-native-adapter', path: '[OA]/src/features/background-agent/**' },
  { id: 'task-toast-manager-feature', category: 'needs-native-adapter', path: '[OA]/src/features/task-toast-manager/**' },
  { id: 'tool-metadata-store-feature', category: 'needs-native-adapter', path: '[OA]/src/features/tool-metadata-store/**' },
  { id: 'start-work-hook', category: 'needs-native-adapter', path: '[OA]/src/hooks/start-work/start-work-hook.ts' },
  { id: 'create-continuation-hooks', category: 'needs-native-adapter', path: '[OA]/src/plugin/hooks/create-continuation-hooks.ts' },

  // Drop / non-portable glue
  { id: 'plugin-index', category: 'drop', path: '[OA]/src/index.ts' },
  { id: 'plugin-interface', category: 'drop', path: '[OA]/src/plugin-interface.ts' },
  { id: 'plugin-types', category: 'drop', path: '[OA]/src/plugin/types.ts' },
  { id: 'plugin-config', category: 'drop', path: '[OA]/src/plugin-config.ts' },
  { id: 'plugin-identity', category: 'drop', path: '[OA]/src/shared/plugin-identity.ts' },
  { id: 'cli-all', category: 'drop', path: '[OA]/src/cli/**' },
  { id: 'cli-server-connection', category: 'drop', path: '[OA]/src/cli/run/server-connection.ts' },
  { id: 'claude-code-features', category: 'drop', path: '[OA]/src/features/claude-code-*' },
]);

/**
 * Convenience lists of paths by category for callers that only
 * need stable path identifiers.
 */

/** @type {ReadonlyArray<string>} */
export const PORTABLE = Object.freeze(
  OMO_KERNEL_ENTRIES.filter((entry) => entry.category === 'portable').map((entry) => entry.path)
);

/** @type {ReadonlyArray<string>} */
export const NEEDS_NATIVE_ADAPTER = Object.freeze(
  OMO_KERNEL_ENTRIES.filter((entry) => entry.category === 'needs-native-adapter').map((entry) => entry.path)
);

/** @type {ReadonlyArray<string>} */
export const DROP = Object.freeze(
  OMO_KERNEL_ENTRIES.filter((entry) => entry.category === 'drop').map((entry) => entry.path)
);

/**
 * Minimal vertical slice identifiers linking the planning flow
 * to concrete OA entrypoints. The values reference IDs from
 * `OMO_KERNEL_ENTRIES` instead of introducing new paths.
 */

export const VERTICAL_SLICE_ENTRYPOINTS = Object.freeze({
  plan: /** @type {const} */ (['start-work-hook']),
  startWork: /** @type {const} */ (['start-work-hook']),
  boulderConfig: /** @type {const} */ (['boulder-state']),
  atlasPrompt: /** @type {const} */ (['atlas-hooks']),
  taskExecution: /** @type {const} */ ([
    'agent-atlas',
    'agent-sisyphus-junior',
    'agent-prometheus',
  ]),
  continuation: /** @type {const} */ ([
    'delegate-task-sync-continuation',
    'delegate-task-background-continuation',
  ]),
  idleHooks: /** @type {const} */ ([
    'todo-continuation-enforcer-hooks',
    'atlas-hooks',
  ]),
});
