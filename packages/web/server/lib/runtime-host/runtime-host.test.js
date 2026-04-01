import { describe, expect, it } from 'bun:test';

import { RUNTIME_EVENT_VERSION } from '../runtime-contracts/index.js';
import { RETRY_ERROR_CODE, createInMemoryRuntimeHostStore, createRuntimeHost } from './index.js';

const FIXED_ISO = '2026-04-02T00:00:00.000Z';

const createTestHost = () => {
  const store = createInMemoryRuntimeHostStore();
  const host = createRuntimeHost({
    now: () => FIXED_ISO,
    store,
    runtimeID: 'runtime-test',
    instanceID: 'instance-test',
  });

  return { host, store };
};

describe('runtime host', () => {
  it('emits enqueue -> start -> complete in deterministic order', () => {
    const { host, store } = createTestHost();
    const events = [];
    const unsubscribe = host.subscribe((event) => events.push(event));

    const task = host.enqueueTask({ metadata: { intent: 'happy-path' } });
    host.startTask(task.taskID);
    const completedTask = host.completeTask(task.taskID, { ok: true });

    unsubscribe();

    expect(task.taskID).toBe('task-0001');
    expect(task.correlationID).toBe('corr-0001');
    expect(completedTask.status).toBe('completed');
    expect(host.getHostSnapshot().status).toBe('idle');

    expect(events.map((event) => event.type)).toEqual(['task.enqueued', 'task.started', 'task.completed']);
    expect(events.map((event) => event.payload.eventSequence)).toEqual([1, 2, 3]);
    expect(events.every((event) => event.schemaVersion === RUNTIME_EVENT_VERSION)).toBe(true);
    expect(events.every((event) => event.occurredAt === FIXED_ISO)).toBe(true);

    const persistedEvents = store.getEvents();
    expect(persistedEvents.map((event) => event.type)).toEqual(['task.enqueued', 'task.started', 'task.completed']);
  });

  it('cancels queued and running tasks with one final cancellation event per task', () => {
    const { host } = createTestHost();
    const events = [];
    host.subscribe((event) => events.push(event));

    const queuedTask = host.enqueueTask({ metadata: { scenario: 'queued-cancel' } });
    host.cancelTask(queuedTask.taskID, 'user requested');

    const runningTask = host.enqueueTask({ metadata: { scenario: 'running-cancel' } });
    host.startTask(runningTask.taskID);
    host.cancelTask(runningTask.taskID, 'timeout');

    const finalStates = host.listTasks().map((task) => ({ id: task.taskID, status: task.status }));

    expect(finalStates).toEqual([
      { id: 'task-0001', status: 'cancelled' },
      { id: 'task-0002', status: 'cancelled' },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      'task.enqueued',
      'task.cancelled',
      'task.enqueued',
      'task.started',
      'task.cancelled',
    ]);

    const cancelEvents = events.filter((event) => event.type === 'task.cancelled');
    expect(cancelEvents).toHaveLength(2);
    expect(cancelEvents[0].payload.fromStatus).toBe('queued');
    expect(cancelEvents[1].payload.fromStatus).toBe('running');
  });

  it('treats repeated cancel requests as idempotent no-op after cancellation', () => {
    const { host } = createTestHost();
    const events = [];
    host.subscribe((event) => events.push(event));

    const task = host.enqueueTask({});
    host.cancelTask(task.taskID, 'user requested');
    host.cancelTask(task.taskID, 'duplicate cancel request');

    expect(host.getTask(task.taskID)?.status).toBe('cancelled');
    expect(events.map((event) => event.type)).toEqual(['task.enqueued', 'task.cancelled']);
    expect(events.filter((event) => event.type === 'task.cancelled')).toHaveLength(1);
  });

  it('exposes deterministic retry stub error semantics', () => {
    const { host } = createTestHost();

    expect(() => host.retryTask('task-0001')).toThrow('runtime-host retryTask is not implemented');

    try {
      host.retryTask('task-0001');
    } catch (error) {
      expect(error.code).toBe(RETRY_ERROR_CODE);
    }
  });
});
