import { RUNTIME_CONTRACT_VERSION, RUNTIME_EVENT_VERSION } from '../runtime-contracts/index.js';

export const RUNTIME_PERSISTENCE_SNAPSHOT_VERSION = 'runtime.persistence.snapshot.v1';
export const RUNTIME_PERSISTENCE_EVENT_RECORD_VERSION = 'runtime.persistence.event-record.v1';

export const REPLAY_ERROR_CODE = Object.freeze({
  MALFORMED_EVENT: 'RUNTIME_REPLAY_MALFORMED_EVENT',
  INVALID_ORDER: 'RUNTIME_REPLAY_INVALID_ORDER',
  RUNTIME_MISMATCH: 'RUNTIME_REPLAY_RUNTIME_MISMATCH',
  INVALID_TRANSITION: 'RUNTIME_REPLAY_INVALID_TRANSITION',
});

export const ARTIFACT_CATEGORY = Object.freeze({
  EVIDENCE: 'evidence',
  PLANS: 'plans',
  HANDOFFS: 'handoffs',
});

const ARTIFACT_CATEGORY_DIRECTORY = Object.freeze({
  [ARTIFACT_CATEGORY.EVIDENCE]: 'evidence',
  [ARTIFACT_CATEGORY.PLANS]: 'plans',
  [ARTIFACT_CATEGORY.HANDOFFS]: 'handoffs',
});

const cloneValue = (value) => JSON.parse(JSON.stringify(value));

const ensureObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

const parseCounter = (value, prefix) => {
  if (typeof value !== 'string') {
    return 0;
  }

  const normalized = value.trim();
  if (!normalized.startsWith(`${prefix}-`)) {
    return 0;
  }

  const suffix = normalized.slice(prefix.length + 1);
  if (!/^\d+$/.test(suffix)) {
    return 0;
  }

  return Number.parseInt(suffix, 10);
};

const ensureEventPayload = (event, index) => {
  const payload = ensureObject(event.payload);
  if (!payload) {
    throw new RuntimeReplayError(
      REPLAY_ERROR_CODE.MALFORMED_EVENT,
      `Event at index ${index} has invalid payload; expected an object.`,
    );
  }

  const eventSequence = payload.eventSequence;
  if (!Number.isInteger(eventSequence) || eventSequence < 1) {
    throw new RuntimeReplayError(
      REPLAY_ERROR_CODE.MALFORMED_EVENT,
      `Event at index ${index} must include a positive integer payload.eventSequence.`,
    );
  }

  return payload;
};

const assertTaskTransition = ({ task, expectedStatus, nextStatus, event, index }) => {
  if (!task) {
    throw new RuntimeReplayError(
      REPLAY_ERROR_CODE.INVALID_TRANSITION,
      `Event at index ${index} (${event.type}) references unknown task ${String(event.taskID)}.`,
    );
  }

  if (task.status !== expectedStatus) {
    throw new RuntimeReplayError(
      REPLAY_ERROR_CODE.INVALID_TRANSITION,
      `Event at index ${index} (${event.type}) expected task ${task.taskID} status ${expectedStatus} but found ${task.status}.`,
    );
  }

  task.status = nextStatus;
  task.updatedAt = event.occurredAt;
};

const updateHostStatusFromTasks = (host, tasks) => {
  for (const task of tasks.values()) {
    if (task.status === 'running') {
      host.status = 'busy';
      return;
    }
  }

  host.status = 'idle';
};

const parseSnapshotRecord = (raw, runtimeID) => {
  const parsed = ensureObject(raw);
  if (!parsed) {
    throw new Error('runtime-persistence snapshot file is malformed: expected an object');
  }

  if (parsed.schemaVersion !== RUNTIME_PERSISTENCE_SNAPSHOT_VERSION) {
    throw new Error(
      `runtime-persistence snapshot schema mismatch: expected ${RUNTIME_PERSISTENCE_SNAPSHOT_VERSION}`,
    );
  }

  if (parsed.runtimeID !== runtimeID) {
    throw new Error(
      `runtime-persistence snapshot runtime mismatch: expected ${runtimeID}, received ${String(parsed.runtimeID)}`,
    );
  }

  if (!ensureObject(parsed.snapshot)) {
    throw new Error('runtime-persistence snapshot file is malformed: missing snapshot object');
  }

  return parsed;
};

const parseEventRecordLine = (line, runtimeID, lineNumber) => {
  if (line.trim().length === 0) {
    return null;
  }

  const parsed = JSON.parse(line);
  const record = ensureObject(parsed);
  if (!record) {
    throw new Error(`runtime-persistence event log is malformed at line ${lineNumber}`);
  }

  if (record.schemaVersion !== RUNTIME_PERSISTENCE_EVENT_RECORD_VERSION) {
    throw new Error(
      `runtime-persistence event log schema mismatch at line ${lineNumber}; expected ${RUNTIME_PERSISTENCE_EVENT_RECORD_VERSION}`,
    );
  }

  if (record.runtimeID !== runtimeID) {
    throw new Error(
      `runtime-persistence event log runtime mismatch at line ${lineNumber}; expected ${runtimeID}, received ${String(record.runtimeID)}`,
    );
  }

  if (!ensureObject(record.event)) {
    throw new Error(`runtime-persistence event log is malformed at line ${lineNumber}: missing event`);
  }

  return record;
};

const normalizeBaseDirectory = (path, baseDirectory) => {
  if (typeof baseDirectory === 'string' && baseDirectory.trim().length > 0) {
    return path.resolve(baseDirectory);
  }

  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) {
    throw new Error('runtime-persistence requires baseDirectory when HOME/USERPROFILE is unavailable');
  }

  return path.join(home, '.sisyphus');
};

export class RuntimeReplayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeReplayError';
    this.code = code;
  }
}

export const createRuntimePersistenceStore = ({
  fsPromises,
  path,
  baseDirectory,
  runtimeID = 'runtime-host',
  snapshotFileName = 'runtime-snapshot.json',
  eventLogFileName = 'runtime-events.ndjson',
} = {}) => {
  if (!fsPromises || typeof fsPromises.readFile !== 'function' || typeof fsPromises.writeFile !== 'function') {
    throw new Error('createRuntimePersistenceStore requires fsPromises with readFile/writeFile support');
  }

  if (!path || typeof path.join !== 'function' || typeof path.dirname !== 'function') {
    throw new Error('createRuntimePersistenceStore requires path helpers');
  }

  if (typeof runtimeID !== 'string' || runtimeID.trim().length === 0) {
    throw new Error('createRuntimePersistenceStore requires a non-empty runtimeID');
  }

  const runtimeDirectory = path.join(normalizeBaseDirectory(path, baseDirectory), 'runtime', runtimeID);
  const snapshotPath = path.join(runtimeDirectory, snapshotFileName);
  const eventLogPath = path.join(runtimeDirectory, eventLogFileName);

  const load = async () => {
    try {
      const raw = await fsPromises.readFile(snapshotPath, 'utf8');
      const record = parseSnapshotRecord(JSON.parse(raw), runtimeID);
      return cloneValue(record.snapshot);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  };

  const save = async (snapshot) => {
    const nextSnapshot = ensureObject(snapshot);
    if (!nextSnapshot) {
      throw new Error('runtime-persistence save requires a snapshot object');
    }

    const record = {
      schemaVersion: RUNTIME_PERSISTENCE_SNAPSHOT_VERSION,
      runtimeID,
      savedAt: new Date().toISOString(),
      snapshot: cloneValue(nextSnapshot),
    };

    await fsPromises.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fsPromises.writeFile(snapshotPath, JSON.stringify(record, null, 2), 'utf8');
  };

  const append = async (event) => {
    const parsedEvent = ensureObject(event);
    if (!parsedEvent) {
      throw new Error('runtime-persistence append requires an event object');
    }

    const record = {
      schemaVersion: RUNTIME_PERSISTENCE_EVENT_RECORD_VERSION,
      runtimeID,
      appendedAt: new Date().toISOString(),
      event: cloneValue(parsedEvent),
    };

    await fsPromises.mkdir(path.dirname(eventLogPath), { recursive: true });
    await fsPromises.appendFile(eventLogPath, `${JSON.stringify(record)}\n`, 'utf8');
  };

  const getEvents = async () => {
    try {
      const raw = await fsPromises.readFile(eventLogPath, 'utf8');
      const lines = raw.split(/\r?\n/);
      const events = [];
      for (let index = 0; index < lines.length; index += 1) {
        const record = parseEventRecordLine(lines[index], runtimeID, index + 1);
        if (!record) {
          continue;
        }
        events.push(cloneValue(record.event));
      }
      return events;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  };

  return {
    runtimeDirectory,
    snapshotPath,
    eventLogPath,
    load,
    save,
    append,
    getEvents,
  };
};

export const replayRuntimeEvents = (eventsInput) => {
  if (!Array.isArray(eventsInput)) {
    throw new RuntimeReplayError(REPLAY_ERROR_CODE.MALFORMED_EVENT, 'replayRuntimeEvents requires RuntimeEvent[] input');
  }

  if (eventsInput.length === 0) {
    return {
      host: null,
      tasks: [],
      counters: {
        taskCounter: 0,
        correlationCounter: 0,
        eventCounter: 0,
      },
    };
  }

  const events = eventsInput.map((event) => cloneValue(event));
  const firstEvent = events[0];

  if (!ensureObject(firstEvent) || typeof firstEvent.runtimeID !== 'string' || firstEvent.runtimeID.trim().length === 0) {
    throw new RuntimeReplayError(REPLAY_ERROR_CODE.MALFORMED_EVENT, 'First event must include a non-empty runtimeID');
  }

  const runtimeID = firstEvent.runtimeID;
  const host = {
    schemaVersion: RUNTIME_CONTRACT_VERSION,
    runtimeID,
    instanceID: `replay-${runtimeID}`,
    hostKind: 'web',
    startedAt: firstEvent.occurredAt,
    status: 'idle',
  };

  const tasks = new Map();
  const taskOrder = [];
  const counters = {
    taskCounter: 0,
    correlationCounter: 0,
    eventCounter: 0,
  };

  let expectedSequence = 1;

  for (let index = 0; index < events.length; index += 1) {
    const event = ensureObject(events[index]);
    if (!event) {
      throw new RuntimeReplayError(REPLAY_ERROR_CODE.MALFORMED_EVENT, `Event at index ${index} is not an object`);
    }

    if (event.schemaVersion !== RUNTIME_EVENT_VERSION) {
      throw new RuntimeReplayError(
        REPLAY_ERROR_CODE.MALFORMED_EVENT,
        `Event at index ${index} has schemaVersion ${String(event.schemaVersion)}; expected ${RUNTIME_EVENT_VERSION}`,
      );
    }

    if (event.runtimeID !== runtimeID) {
      throw new RuntimeReplayError(
        REPLAY_ERROR_CODE.RUNTIME_MISMATCH,
        `Event at index ${index} runtime mismatch: expected ${runtimeID}, received ${String(event.runtimeID)}`,
      );
    }

    if (typeof event.type !== 'string') {
      throw new RuntimeReplayError(REPLAY_ERROR_CODE.MALFORMED_EVENT, `Event at index ${index} has invalid type`);
    }

    if (typeof event.occurredAt !== 'string' || event.occurredAt.trim().length === 0) {
      throw new RuntimeReplayError(REPLAY_ERROR_CODE.MALFORMED_EVENT, `Event at index ${index} has invalid occurredAt`);
    }

    const payload = ensureEventPayload(event, index);
    if (payload.eventSequence !== expectedSequence) {
      throw new RuntimeReplayError(
        REPLAY_ERROR_CODE.INVALID_ORDER,
        `Event at index ${index} has payload.eventSequence=${payload.eventSequence}; expected ${expectedSequence}`,
      );
    }

    counters.eventCounter = payload.eventSequence;
    expectedSequence += 1;

    if (typeof event.taskID === 'string' && event.taskID.trim().length > 0) {
      counters.taskCounter = Math.max(counters.taskCounter, parseCounter(event.taskID, 'task'));
    }

    if (typeof payload.correlationID === 'string' && payload.correlationID.trim().length > 0) {
      counters.correlationCounter = Math.max(counters.correlationCounter, parseCounter(payload.correlationID, 'corr'));
    }

    if (event.type === 'task.enqueued') {
      if (typeof event.taskID !== 'string' || event.taskID.trim().length === 0) {
        throw new RuntimeReplayError(
          REPLAY_ERROR_CODE.MALFORMED_EVENT,
          `Event at index ${index} (${event.type}) requires taskID`,
        );
      }

      if (tasks.has(event.taskID)) {
        throw new RuntimeReplayError(
          REPLAY_ERROR_CODE.INVALID_ORDER,
          `Event at index ${index} attempted to enqueue duplicate task ${event.taskID}`,
        );
      }

      tasks.set(event.taskID, {
        schemaVersion: RUNTIME_CONTRACT_VERSION,
        taskID: event.taskID,
        runtimeID,
        correlationID: typeof payload.correlationID === 'string' ? payload.correlationID : null,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
        startedAt: null,
        finishedAt: null,
        status: 'queued',
        metadata: {},
      });
      taskOrder.push(event.taskID);
      updateHostStatusFromTasks(host, tasks);
      continue;
    }

    if (event.type === 'task.started') {
      const task = tasks.get(event.taskID);
      assertTaskTransition({ task, expectedStatus: 'queued', nextStatus: 'running', event, index });
      task.startedAt = event.occurredAt;
      task.finishedAt = null;
      updateHostStatusFromTasks(host, tasks);
      continue;
    }

    if (event.type === 'task.completed') {
      const task = tasks.get(event.taskID);
      assertTaskTransition({ task, expectedStatus: 'running', nextStatus: 'completed', event, index });
      task.finishedAt = event.occurredAt;
      if (Object.prototype.hasOwnProperty.call(payload, 'output')) {
        task.output = cloneValue(payload.output);
      }
      updateHostStatusFromTasks(host, tasks);
      continue;
    }

    if (event.type === 'task.failed') {
      const task = tasks.get(event.taskID);
      assertTaskTransition({ task, expectedStatus: 'running', nextStatus: 'failed', event, index });
      task.finishedAt = event.occurredAt;
      if (Object.prototype.hasOwnProperty.call(payload, 'error')) {
        task.error = cloneValue(payload.error);
      }
      updateHostStatusFromTasks(host, tasks);
      continue;
    }

    if (event.type === 'task.cancelled') {
      const task = tasks.get(event.taskID);
      if (!task) {
        throw new RuntimeReplayError(
          REPLAY_ERROR_CODE.INVALID_TRANSITION,
          `Event at index ${index} (${event.type}) references unknown task ${String(event.taskID)}.`,
        );
      }

      if (task.status !== 'queued' && task.status !== 'running') {
        throw new RuntimeReplayError(
          REPLAY_ERROR_CODE.INVALID_TRANSITION,
          `Event at index ${index} (${event.type}) expected queued/running task ${task.taskID} but found ${task.status}.`,
        );
      }

      task.status = 'cancelled';
      task.updatedAt = event.occurredAt;
      task.finishedAt = event.occurredAt;
      if (typeof payload.reason === 'string' && payload.reason.length > 0) {
        task.cancelReason = payload.reason;
      }
      updateHostStatusFromTasks(host, tasks);
      continue;
    }

    if (event.type === 'runtime.started') {
      host.startedAt = event.occurredAt;
      updateHostStatusFromTasks(host, tasks);
      continue;
    }

    if (event.type === 'runtime.stopped') {
      host.status = 'stopped';
      continue;
    }

    if (event.type === 'provider.negotiated' || event.type === 'provider.error') {
      updateHostStatusFromTasks(host, tasks);
      continue;
    }

    if (
      event.type === 'tool.queued' ||
      event.type === 'tool.running' ||
      event.type === 'tool.completed' ||
      event.type === 'tool.failed' ||
      event.type === 'tool.cancelled' ||
      event.type === 'approval.requested' ||
      event.type === 'approval.granted' ||
      event.type === 'approval.denied'
    ) {
      updateHostStatusFromTasks(host, tasks);
      continue;
    }

    throw new RuntimeReplayError(
      REPLAY_ERROR_CODE.MALFORMED_EVENT,
      `Event at index ${index} has unsupported type ${event.type}`,
    );
  }

  if (host.status !== 'stopped') {
    updateHostStatusFromTasks(host, tasks);
  }

  return {
    host,
    tasks: taskOrder.map((taskID) => cloneValue(tasks.get(taskID))).filter(Boolean),
    counters,
  };
};

export const createRuntimeArtifactStore = ({ fsPromises, path, baseDirectory } = {}) => {
  if (!fsPromises || typeof fsPromises.readFile !== 'function' || typeof fsPromises.writeFile !== 'function') {
    throw new Error('createRuntimeArtifactStore requires fsPromises with readFile/writeFile support');
  }

  if (!path || typeof path.join !== 'function' || typeof path.basename !== 'function') {
    throw new Error('createRuntimeArtifactStore requires path helpers');
  }

  const rootDirectory = normalizeBaseDirectory(path, baseDirectory);

  const resolveArtifactPath = (category, fileName) => {
    const directory = ARTIFACT_CATEGORY_DIRECTORY[category];
    if (!directory) {
      throw new Error(`Unsupported artifact category: ${String(category)}`);
    }

    if (typeof fileName !== 'string' || fileName.trim().length === 0) {
      throw new Error('Artifact file name must be a non-empty string');
    }

    if (path.basename(fileName) !== fileName) {
      throw new Error(`Artifact file name must not include path segments: ${fileName}`);
    }

    return path.join(rootDirectory, directory, fileName);
  };

  const writeArtifact = async (category, fileName, content) => {
    const artifactPath = resolveArtifactPath(category, fileName);
    await fsPromises.mkdir(path.dirname(artifactPath), { recursive: true });
    await fsPromises.writeFile(artifactPath, String(content), 'utf8');
    return artifactPath;
  };

  const readArtifact = async (category, fileName) => {
    const artifactPath = resolveArtifactPath(category, fileName);
    return fsPromises.readFile(artifactPath, 'utf8');
  };

  return {
    rootDirectory,
    categories: cloneValue(ARTIFACT_CATEGORY_DIRECTORY),
    resolveArtifactPath,
    writeArtifact,
    readArtifact,
  };
};
