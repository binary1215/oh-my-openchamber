import { describe, expect, it } from 'bun:test';

import { DROP, OMO_KERNEL_ENTRIES, PORTABLE } from './index.js';

const REQUIRED_CLASSIFIED_PATHS = Object.freeze([
  '[OA]/docs/guide/orchestration.md',
  '[OA]/docs/reference/features.md',
  '[OA]/src/agents/atlas/agent.ts',
  '[OA]/src/agents/prometheus/**',
  '[OA]/src/agents/sisyphus-junior/**',
  '[OA]/src/tools/delegate-task/constants.ts',
  '[OA]/src/tools/delegate-task/categories.ts',
  '[OA]/src/tools/delegate-task/tools.ts',
  '[OA]/src/tools/delegate-task/executor.ts',
  '[OA]/src/tools/delegate-task/prompt-builder.ts',
  '[OA]/src/tools/session-manager/session-formatter.ts',
  '[OA]/src/plugin-interface.ts',
  '[OA]/src/cli/run/server-connection.ts',
]);

const REQUIRED_NON_PORTABLE_PATHS = Object.freeze([
  '[OA]/src/plugin-interface.ts',
  '[OA]/src/cli/run/server-connection.ts',
  '[OA]/src/plugin-config.ts',
]);

describe('omo inventory', () => {
  it('includes required portable kernel specs', () => {
    expect(PORTABLE).toContain('[OA]/docs/guide/orchestration.md');
    expect(PORTABLE).toContain('[OA]/src/agents/atlas/agent.ts');
  });

  it('includes required drop / non-portable glue entries', () => {
    expect(DROP).toContain('[OA]/src/plugin-interface.ts');
    expect(DROP).toContain('[OA]/src/cli/run/server-connection.ts');
  });

  it('does not label known non-portable prefixes as portable', () => {
    const dropPrefixes = ['[OA]/src/cli/', '[OA]/src/plugin-', '[OA]/src/features/claude-code-'];

    for (const path of PORTABLE) {
      const prefix = dropPrefixes.find((candidate) => path.startsWith(candidate));
      if (prefix) {
        throw new Error(`Portable entry ${path} uses non-portable drop prefix ${prefix}`);
      }
    }
  });

  it('has no duplicate IDs and no cross-category duplicates', () => {
    const seenIds = new Set();
    const seenPathsByCategory = new Map();

    for (const entry of OMO_KERNEL_ENTRIES) {
      expect(entry.id).toBeTruthy();
      expect(entry.path).toBeTruthy();

      if (seenIds.has(entry.id)) {
        throw new Error(`Duplicate OMO kernel entry id detected: ${entry.id}`);
      }
      seenIds.add(entry.id);

      const key = `${entry.category}:${entry.path}`;
      if (seenPathsByCategory.has(key)) {
        throw new Error(`Duplicate OMO kernel entry for ${key}`);
      }
      seenPathsByCategory.set(key, true);
    }
  });

  it('classifies every required user-visible OMO source path', () => {
    const allPaths = new Set(OMO_KERNEL_ENTRIES.map((entry) => entry.path));

    for (const requiredPath of REQUIRED_CLASSIFIED_PATHS) {
      expect(allPaths.has(requiredPath)).toBe(true);
    }
  });

  it('rejects non-portable glue from portable classification explicitly', () => {
    const portable = new Set(PORTABLE);
    const dropped = new Set(DROP);

    for (const path of REQUIRED_NON_PORTABLE_PATHS) {
      expect(portable.has(path)).toBe(false);
      expect(dropped.has(path)).toBe(true);
    }
  });
});
