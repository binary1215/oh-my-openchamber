import { describe, expect, it } from 'bun:test';

import {
  NEGOTIATION_OUTCOME,
  RUNTIME_EVENT_VERSION,
  TASK_TRANSITION_RULES,
  TASK_STATUS,
  canTransitionTaskStatus,
  createRuntimeEvent,
  isRuntimeEventType,
  negotiateProviderCapabilities,
} from './index.js';

describe('runtime contracts', () => {
  it('creates runtime event envelopes with runtime.event.v1 schema version', () => {
    const event = createRuntimeEvent({
      type: 'runtime.started',
      runtimeID: 'runtime-1',
      payload: { bootMode: 'cold' },
    });

    expect(event.schemaVersion).toBe(RUNTIME_EVENT_VERSION);
    expect(event.type).toBe('runtime.started');
    expect(event.runtimeID).toBe('runtime-1');
    expect(event.payload).toEqual({ bootMode: 'cold' });
    expect(typeof event.occurredAt).toBe('string');
  });

  it('rejects unknown runtime event discriminants', () => {
    expect(() =>
      createRuntimeEvent({
        type: /** @type {import('./index.js').RuntimeEventType} */ ('runtime.unknown'),
        runtimeID: 'runtime-1',
      })
    ).toThrow('Unsupported runtime event type');

    expect(isRuntimeEventType('runtime.started')).toBe(true);
    expect(isRuntimeEventType('tool.queued')).toBe(true);
    expect(isRuntimeEventType('runtime.unknown')).toBe(false);
  });

  it('refuses provider negotiation when required non-degradable capabilities are missing', () => {
    const result = negotiateProviderCapabilities({
      required: ['streaming', 'tools'],
      available: ['streaming'],
      degradable: [],
    });

    expect(result.outcome).toBe(NEGOTIATION_OUTCOME.REFUSE);
    expect(result.missingCapabilities).toEqual(['tools']);
    expect(result.degradedCapabilities).toEqual([]);
  });

  it('degrades provider negotiation when only degradable capabilities are missing', () => {
    const result = negotiateProviderCapabilities({
      required: ['streaming', 'images'],
      available: ['streaming'],
      degradable: ['images'],
    });

    expect(result.outcome).toBe(NEGOTIATION_OUTCOME.DEGRADE);
    expect(result.missingCapabilities).toEqual(['images']);
    expect(result.degradedCapabilities).toEqual(['images']);
  });

  it('defines contract-level task states including waiting, tool, and blocked transitions', () => {
    expect(TASK_STATUS.WAITING).toBe('waiting');
    expect(TASK_STATUS.TOOL).toBe('tool');
    expect(TASK_STATUS.BLOCKED).toBe('blocked');

    expect(canTransitionTaskStatus('queued', 'waiting')).toBe(true);
    expect(canTransitionTaskStatus('running', 'tool')).toBe(true);
    expect(canTransitionTaskStatus('waiting', 'cancelled')).toBe(true);
    expect(canTransitionTaskStatus('blocked', 'running')).toBe(true);
    expect(canTransitionTaskStatus('completed', 'running')).toBe(false);
    expect(canTransitionTaskStatus('failed', 'completed')).toBe(false);
  });

  it('proves the full task transition matrix invariants', () => {
    const allStatuses = Object.values(TASK_STATUS);

    for (const fromStatus of allStatuses) {
      const allowed = new Set(TASK_TRANSITION_RULES[fromStatus]);

      for (const toStatus of allStatuses) {
        expect(canTransitionTaskStatus(fromStatus, toStatus)).toBe(allowed.has(toStatus));
      }
    }
  });
});
