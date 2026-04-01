import { describe, expect, it } from 'bun:test';

import { createApprovalBridge, createToolDispatcher, createToolRegistry } from './index.js';

const createDeterministicNow = () => {
  let tick = 0;
  return () => {
    const timestamp = new Date(Date.UTC(2026, 3, 2, 0, 0, tick)).toISOString();
    tick += 1;
    return timestamp;
  };
};

const createTestHarness = ({ tools, hasPermission } = {}) => {
  const now = createDeterministicNow();
  const events = [];
  const registry = createToolRegistry({ tools });
  const approvalBridge = createApprovalBridge({ now });
  const dispatcher = createToolDispatcher({
    registry,
    approvalBridge,
    now,
    runtimeID: 'runtime-tool-fabric-test',
    emitEvent: (event) => events.push(event),
    hasPermission,
  });

  return {
    dispatcher,
    approvalBridge,
    events,
  };
};

describe('tool fabric', () => {
  it('completes a tool invocation with deterministic event order', async () => {
    const { dispatcher, events } = createTestHarness({
      tools: [
        {
          name: 'sum',
          permissionScope: 'tool:math',
          timeoutPolicy: { timeoutMs: 1000 },
          resultSchema: { type: 'object' },
          execute: ({ input }) => ({ total: Number(input.a) + Number(input.b) }),
        },
      ],
    });

    const invocation = dispatcher.invokeTool({
      taskID: 'task-0001',
      toolName: 'sum',
      input: { a: 2, b: 3 },
    });

    const result = await invocation.result;

    expect(result.ok).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ total: 5 });

    expect(events.map((event) => event.type)).toEqual(['tool.queued', 'tool.running', 'tool.completed']);
    expect(events.map((event) => event.payload.eventSequence)).toEqual([1, 2, 3]);
  });

  it('fails with a structured timeout error when execution exceeds timeout policy', async () => {
    const { dispatcher, events } = createTestHarness({
      tools: [
        {
          name: 'slow',
          permissionScope: 'tool:slow',
          timeoutPolicy: { timeoutMs: 10 },
          resultSchema: { type: 'object' },
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { ok: true };
          },
        },
      ],
    });

    const invocation = dispatcher.invokeTool({
      taskID: 'task-0002',
      toolName: 'slow',
      input: {},
    });

    const result = await invocation.result;

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error.code).toBe('TOOL_FABRIC_TIMEOUT');
    expect(events.at(-1)?.type).toBe('tool.failed');
  });

  it('returns deterministic permission-denied error and does not execute the tool', async () => {
    let executeCalled = false;
    const { dispatcher, events } = createTestHarness({
      tools: [
        {
          name: 'secure-tool',
          permissionScope: 'tool:secure',
          timeoutPolicy: { timeoutMs: 1000 },
          resultSchema: { type: 'object' },
          execute: () => {
            executeCalled = true;
            return { ok: true };
          },
        },
      ],
      hasPermission: () => false,
    });

    const invocation = dispatcher.invokeTool({
      taskID: 'task-0003',
      toolName: 'secure-tool',
      input: {},
    });

    const result = await invocation.result;

    expect(executeCalled).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error.code).toBe('TOOL_FABRIC_PERMISSION_DENIED');
    expect(events.map((event) => event.type)).toEqual(['tool.queued', 'tool.failed']);
  });

  it('cancels during approval wait without dangling approval requests', async () => {
    const { dispatcher, approvalBridge, events } = createTestHarness({
      tools: [
        {
          name: 'approval-tool',
          permissionScope: 'tool:approval',
          requiresApproval: true,
          timeoutPolicy: { timeoutMs: 1000 },
          resultSchema: { type: 'object' },
          execute: () => ({ ok: true }),
        },
      ],
    });

    const invocation = dispatcher.invokeTool({
      taskID: 'task-0004',
      toolName: 'approval-tool',
      input: {},
    });

    const pending = approvalBridge.listPending();
    expect(pending).toHaveLength(1);

    const firstCancel = invocation.cancel('user aborted approval wait');
    const secondCancel = invocation.cancel('duplicate cancel');
    const result = await invocation.result;

    expect(firstCancel).toBe(true);
    expect(secondCancel).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('cancelled');
    expect(result.error.code).toBe('TOOL_FABRIC_CANCELLED');
    expect(approvalBridge.listPending()).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(['tool.queued', 'approval.requested', 'tool.cancelled']);
  });

  it('treats repeated approval decisions and duplicate cancel as idempotent no-op after terminal state', async () => {
    const now = createDeterministicNow();
    const approvalBridge = createApprovalBridge({ now });

    const directRequest = approvalBridge.requestApproval({
      taskID: 'task-approval-1',
      invocationID: 'invocation-approval-1',
      toolName: 'manual',
      input: {},
    });

    const firstDeny = approvalBridge.deny(directRequest.approvalID, { reason: 'policy denied' });
    const secondDeny = approvalBridge.deny(directRequest.approvalID, { reason: 'duplicate deny' });
    const secondApprove = approvalBridge.approve(directRequest.approvalID, { reason: 'late approve' });
    const secondCancel = approvalBridge.cancel(directRequest.approvalID, 'late cancel');
    const directDecision = await directRequest.decision;

    expect(firstDeny).toEqual({ ok: true, status: 'denied', approvalID: directRequest.approvalID });
    expect(secondDeny.status).toBe('noop');
    expect(secondApprove.status).toBe('noop');
    expect(secondCancel.status).toBe('noop');
    expect(directDecision.status).toBe('denied');

    const events = [];
    const registry = createToolRegistry({
      tools: [
        {
          name: 'requires-approval',
          permissionScope: 'tool:approval',
          requiresApproval: true,
          timeoutPolicy: { timeoutMs: 1000 },
          resultSchema: { type: 'object' },
          execute: () => ({ ok: true }),
        },
      ],
    });

    const dispatcher = createToolDispatcher({
      registry,
      approvalBridge,
      now,
      runtimeID: 'runtime-tool-fabric-test',
      emitEvent: (event) => events.push(event),
    });

    const invocation = dispatcher.invokeTool({
      taskID: 'task-0005',
      toolName: 'requires-approval',
      input: {},
    });

    const pendingRequest = approvalBridge.listPending()[0];
    const approveResult = approvalBridge.approve(pendingRequest.approvalID, { actor: 'tester' });
    const denyNoop = approvalBridge.deny(pendingRequest.approvalID, { actor: 'tester' });
    const output = await invocation.result;
    const cancelNoop = invocation.cancel('late cancel after completion');

    expect(approveResult.status).toBe('approved');
    expect(denyNoop.status).toBe('noop');
    expect(cancelNoop).toBe(false);
    expect(output.ok).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      'tool.queued',
      'approval.requested',
      'approval.granted',
      'tool.running',
      'tool.completed',
    ]);
  });
});
