import { describe, expect, it } from 'bun:test';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntimeHost, createInMemoryRuntimeHostStore } from '../runtime-host/index.js';
import { createRuntimeEvent } from '../runtime-contracts/index.js';
import {
  ARTIFACT_CATEGORY,
  REPLAY_ERROR_CODE,
  RUNTIME_PERSISTENCE_EVENT_RECORD_VERSION,
  RUNTIME_PERSISTENCE_SNAPSHOT_VERSION,
  RuntimeReplayError,
  createRuntimeArtifactStore,
  createRuntimePersistenceStore,
  replayRuntimeEvents,
} from './index.js';

const createTempDirectory = async () => fsPromises.mkdtemp(path.join(os.tmpdir(), 'runtime-persistence-'));

describe('runtime persistence', () => {
  it('persists versioned snapshot and append-only event log records', async () => {
    const baseDirectory = await createTempDirectory();
    const store = createRuntimePersistenceStore({
      fsPromises,
      path,
      baseDirectory,
      runtimeID: 'runtime-store-test',
    });

    const snapshot = {
      host: { runtimeID: 'runtime-store-test', status: 'idle' },
      tasks: [],
      counters: { taskCounter: 0, correlationCounter: 0, eventCounter: 0 },
    };

    const event = createRuntimeEvent({
      type: 'task.enqueued',
      runtimeID: 'runtime-store-test',
      taskID: 'task-0001',
      occurredAt: '2026-04-02T00:00:00.000Z',
      payload: {
        eventID: 'evt-0001',
        eventSequence: 1,
        correlationID: 'corr-0001',
      },
    });

    await store.save(snapshot);
    await store.append(event);

    const loadedSnapshot = await store.load();
    const loadedEvents = await store.getEvents();

    expect(loadedSnapshot).toEqual(snapshot);
    expect(loadedEvents).toEqual([event]);

    const persistedSnapshotRaw = await fsPromises.readFile(store.snapshotPath, 'utf8');
    const parsedSnapshotRecord = JSON.parse(persistedSnapshotRaw);
    expect(parsedSnapshotRecord.schemaVersion).toBe(RUNTIME_PERSISTENCE_SNAPSHOT_VERSION);

    const persistedEventRaw = await fsPromises.readFile(store.eventLogPath, 'utf8');
    const parsedEventRecord = JSON.parse(persistedEventRaw.trim());
    expect(parsedEventRecord.schemaVersion).toBe(RUNTIME_PERSISTENCE_EVENT_RECORD_VERSION);
  });

  it('replays runtime-host event stream deterministically without provider access', () => {
    const store = createInMemoryRuntimeHostStore();
    const host = createRuntimeHost({
      now: () => '2026-04-02T00:00:00.000Z',
      store,
      runtimeID: 'runtime-replay-test',
      instanceID: 'instance-replay-test',
    });

    const firstTask = host.enqueueTask({ metadata: { feature: 'replay' } });
    host.startTask(firstTask.taskID);
    host.completeTask(firstTask.taskID, { ok: true });

    const secondTask = host.enqueueTask({ metadata: { feature: 'cancel' } });
    host.cancelTask(secondTask.taskID, 'user requested');

    const replayed = replayRuntimeEvents(store.getEvents());

    expect(replayed.host.runtimeID).toBe('runtime-replay-test');
    expect(replayed.host.status).toBe('idle');
    expect(replayed.tasks).toHaveLength(2);
    expect(replayed.tasks[0].status).toBe('completed');
    expect(replayed.tasks[1].status).toBe('cancelled');
    expect(replayed.counters).toEqual({
      taskCounter: 2,
      correlationCounter: 2,
      eventCounter: 5,
    });
  });

  it('fails replay with typed error on out-of-order event sequence', () => {
    const first = createRuntimeEvent({
      type: 'task.enqueued',
      runtimeID: 'runtime-order-test',
      taskID: 'task-0001',
      occurredAt: '2026-04-02T00:00:00.000Z',
      payload: { eventID: 'evt-0001', eventSequence: 1, correlationID: 'corr-0001' },
    });

    const second = createRuntimeEvent({
      type: 'task.started',
      runtimeID: 'runtime-order-test',
      taskID: 'task-0001',
      occurredAt: '2026-04-02T00:00:01.000Z',
      payload: { eventID: 'evt-0002', eventSequence: 3, correlationID: 'corr-0001' },
    });

    expect(() => replayRuntimeEvents([first, second])).toThrow(RuntimeReplayError);

    try {
      replayRuntimeEvents([first, second]);
    } catch (error) {
      expect(error.code).toBe(REPLAY_ERROR_CODE.INVALID_ORDER);
    }
  });

  it('fails replay with typed error on runtime mismatch', () => {
    const first = createRuntimeEvent({
      type: 'task.enqueued',
      runtimeID: 'runtime-a',
      taskID: 'task-0001',
      occurredAt: '2026-04-02T00:00:00.000Z',
      payload: { eventID: 'evt-0001', eventSequence: 1, correlationID: 'corr-0001' },
    });

    const second = createRuntimeEvent({
      type: 'task.started',
      runtimeID: 'runtime-b',
      taskID: 'task-0001',
      occurredAt: '2026-04-02T00:00:01.000Z',
      payload: { eventID: 'evt-0002', eventSequence: 2, correlationID: 'corr-0001' },
    });

    try {
      replayRuntimeEvents([first, second]);
      throw new Error('Expected runtime mismatch replay error');
    } catch (error) {
      expect(error.code).toBe(REPLAY_ERROR_CODE.RUNTIME_MISMATCH);
    }
  });

  it('resolves artifact categories and enforces path boundaries', async () => {
    const baseDirectory = await createTempDirectory();
    const artifacts = createRuntimeArtifactStore({ fsPromises, path, baseDirectory });

    const evidencePath = await artifacts.writeArtifact(
      ARTIFACT_CATEGORY.EVIDENCE,
      'runtime-proof.txt',
      'deterministic replay verified',
    );

    const content = await artifacts.readArtifact(ARTIFACT_CATEGORY.EVIDENCE, 'runtime-proof.txt');
    expect(content).toBe('deterministic replay verified');
    expect(evidencePath).toBe(path.join(baseDirectory, 'evidence', 'runtime-proof.txt'));

    const planPath = artifacts.resolveArtifactPath(ARTIFACT_CATEGORY.PLANS, 'plan-summary.md');
    expect(planPath).toBe(path.join(baseDirectory, 'plans', 'plan-summary.md'));

    expect(() => artifacts.resolveArtifactPath('unsupported', 'x.txt')).toThrow('Unsupported artifact category');
    expect(() => artifacts.resolveArtifactPath(ARTIFACT_CATEGORY.HANDOFFS, '../escape.txt')).toThrow(
      'must not include path segments',
    );
  });
});
