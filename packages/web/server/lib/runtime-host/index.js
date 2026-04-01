import { RUNTIME_CONTRACT_VERSION, createRuntimeEvent } from '../runtime-contracts/index.js';

const DEFAULT_RUNTIME_ID = 'runtime-host';
const DEFAULT_INSTANCE_ID = 'runtime-host-instance';
const DEFAULT_HOST_KIND = 'web';
const RETRY_NOT_IMPLEMENTED_ERROR_CODE = 'RUNTIME_HOST_RETRY_NOT_IMPLEMENTED';

const cloneValue = (value) => JSON.parse(JSON.stringify(value));

const normalizeNow = (now) => {
  if (typeof now !== 'function') {
    throw new Error('createRuntimeHost requires a now() function returning an ISO timestamp');
  }

  return () => {
    const timestamp = now();
    if (typeof timestamp !== 'string' || timestamp.trim().length === 0) {
      throw new Error('runtime-host now() must return a non-empty ISO timestamp string');
    }
    return timestamp;
  };
};

const createSequence = (prefix, initial = 0) => {
  let value = initial;
  return {
    next() {
      value += 1;
      return `${prefix}-${String(value).padStart(4, '0')}`;
    },
    peek() {
      return value;
    },
  };
};

const ensureTaskInput = (input) => {
  const normalized = input && typeof input === 'object' ? input : {};
  const metadata =
    normalized.metadata && typeof normalized.metadata === 'object' && !Array.isArray(normalized.metadata)
      ? normalized.metadata
      : {};

  return {
    metadata: cloneValue(metadata),
    correlationID: typeof normalized.correlationID === 'string' ? normalized.correlationID.trim() : '',
  };
};

const cloneTask = (task) => cloneValue(task);

const getRunningTaskCount = (tasks) => {
  let count = 0;
  for (const task of tasks.values()) {
    if (task.status === 'running') {
      count += 1;
    }
  }
  return count;
};

const setHostStatusFromTasks = (host, tasks) => {
  host.status = getRunningTaskCount(tasks) > 0 ? 'busy' : 'idle';
};

export const createRuntimeEventBus = () => {
  const listeners = new Set();

  const subscribe = (listener) => {
    if (typeof listener !== 'function') {
      throw new Error('runtime-host subscribe requires a listener function');
    }

    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const publish = (event) => {
    for (const listener of [...listeners]) {
      listener(event);
    }
  };

  return {
    subscribe,
    publish,
  };
};

export const createInMemoryRuntimeHostStore = () => {
  let snapshot = null;
  const events = [];

  return {
    load() {
      return snapshot ? cloneValue(snapshot) : null;
    },
    save(nextSnapshot) {
      snapshot = cloneValue(nextSnapshot);
    },
    append(event) {
      events.push(cloneValue(event));
    },
    getEvents() {
      return cloneValue(events);
    },
  };
};

export const createRuntimeHost = ({
  now = () => new Date().toISOString(),
  store = createInMemoryRuntimeHostStore(),
  bus = createRuntimeEventBus(),
  runtimeID = DEFAULT_RUNTIME_ID,
  instanceID = DEFAULT_INSTANCE_ID,
  hostKind = DEFAULT_HOST_KIND,
} = {}) => {
  const nowIso = normalizeNow(now);
  const loaded = store.load() ?? {};

  const taskIDSequence = createSequence('task', loaded.counters?.taskCounter ?? 0);
  const correlationIDSequence = createSequence('corr', loaded.counters?.correlationCounter ?? 0);
  const eventIDSequence = createSequence('evt', loaded.counters?.eventCounter ?? 0);

  const host = loaded.host ?? {
    schemaVersion: RUNTIME_CONTRACT_VERSION,
    runtimeID,
    instanceID,
    hostKind,
    startedAt: nowIso(),
    status: 'idle',
  };

  const tasks = new Map();
  const taskOrder = [];

  if (Array.isArray(loaded.tasks)) {
    for (const storedTask of loaded.tasks) {
      tasks.set(storedTask.taskID, storedTask);
      taskOrder.push(storedTask.taskID);
    }
  }

  const persistSnapshot = () => {
    store.save({
      host,
      tasks: taskOrder.map((taskID) => tasks.get(taskID)).filter(Boolean),
      counters: {
        taskCounter: taskIDSequence.peek(),
        correlationCounter: correlationIDSequence.peek(),
        eventCounter: eventIDSequence.peek(),
      },
    });
  };

  const emit = (type, task, payload = {}) => {
    const eventID = eventIDSequence.next();
    const correlationID =
      typeof payload.correlationID === 'string' && payload.correlationID.length > 0
        ? payload.correlationID
        : task?.correlationID ?? null;

    const event = createRuntimeEvent({
      type,
      runtimeID: host.runtimeID,
      taskID: task?.taskID,
      occurredAt: nowIso(),
      payload: {
        eventID,
        eventSequence: eventIDSequence.peek(),
        correlationID,
        ...payload,
      },
    });

    store.append(event);
    bus.publish(event);
    persistSnapshot();
    return event;
  };

  const getTaskOrThrow = (taskID) => {
    if (typeof taskID !== 'string' || taskID.trim().length === 0) {
      throw new Error('runtime-host requires a non-empty taskID');
    }

    const task = tasks.get(taskID);
    if (!task) {
      throw new Error(`runtime-host task not found: ${taskID}`);
    }

    return task;
  };

  const transitionTask = (task, status, extra = {}) => {
    const transitionedAt = nowIso();
    const nextTask = {
      ...task,
      status,
      updatedAt: transitionedAt,
      ...extra,
    };

    tasks.set(task.taskID, nextTask);
    setHostStatusFromTasks(host, tasks);
    persistSnapshot();

    return nextTask;
  };

  const getHostSnapshot = () => ({
    ...cloneValue(host),
    taskCount: taskOrder.length,
    runningTaskCount: getRunningTaskCount(tasks),
  });

  const listTasks = () => taskOrder.map((taskID) => cloneTask(tasks.get(taskID))).filter(Boolean);

  const getTask = (taskID) => {
    const task = tasks.get(taskID);
    return task ? cloneTask(task) : null;
  };

  const enqueueTask = (input = {}) => {
    const normalized = ensureTaskInput(input);
    const taskID = taskIDSequence.next();
    const correlationID = normalized.correlationID || correlationIDSequence.next();

    const task = {
      schemaVersion: RUNTIME_CONTRACT_VERSION,
      taskID,
      runtimeID: host.runtimeID,
      correlationID,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      status: 'queued',
      metadata: normalized.metadata,
    };

    tasks.set(taskID, task);
    taskOrder.push(taskID);
    persistSnapshot();

    emit('task.enqueued', task, {
      status: task.status,
      taskID: task.taskID,
      correlationID,
    });

    return cloneTask(task);
  };

  const startTask = (taskID) => {
    const task = getTaskOrThrow(taskID);
    if (task.status !== 'queued') {
      throw new Error(`runtime-host startTask requires queued task, received ${task.status}`);
    }

    const runningTask = transitionTask(task, 'running', {
      startedAt: nowIso(),
      finishedAt: null,
    });

    emit('task.started', runningTask, {
      fromStatus: 'queued',
      status: 'running',
    });

    return cloneTask(runningTask);
  };

  const completeTask = (taskID, output = {}) => {
    const task = getTaskOrThrow(taskID);
    if (task.status !== 'running') {
      throw new Error(`runtime-host completeTask requires running task, received ${task.status}`);
    }

    const completedTask = transitionTask(task, 'completed', {
      finishedAt: nowIso(),
      output: cloneValue(output),
    });

    emit('task.completed', completedTask, {
      fromStatus: 'running',
      status: 'completed',
    });

    return cloneTask(completedTask);
  };

  const cancelTask = (taskID, reason = 'cancelled') => {
    const task = getTaskOrThrow(taskID);
    if (task.status === 'cancelled') {
      return cloneTask(task);
    }

    if (task.status !== 'queued' && task.status !== 'running') {
      return cloneTask(task);
    }

    const cancelledTask = transitionTask(task, 'cancelled', {
      finishedAt: nowIso(),
      cancelReason: reason,
    });

    emit('task.cancelled', cancelledTask, {
      fromStatus: task.status,
      status: 'cancelled',
      reason,
    });

    return cloneTask(cancelledTask);
  };

  const retryTask = (taskID) => {
    const error = new Error(`runtime-host retryTask is not implemented for task ${taskID}`);
    error.code = RETRY_NOT_IMPLEMENTED_ERROR_CODE;
    throw error;
  };

  const subscribe = (listener) => bus.subscribe(listener);

  persistSnapshot();

  return {
    getHostSnapshot,
    listTasks,
    getTask,
    enqueueTask,
    startTask,
    completeTask,
    cancelTask,
    retryTask,
    subscribe,
  };
};

export const RETRY_ERROR_CODE = RETRY_NOT_IMPLEMENTED_ERROR_CODE;
