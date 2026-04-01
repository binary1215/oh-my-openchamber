import { createOmoPolicyEngine } from '../omo-policy/index.js';
import {
  createLiteLlmAdapter,
  createOllamaAdapter,
  createOpenAiCompatibleAdapter,
} from '../provider-adapters/index.js';
import { normalizeCapabilityMatrix } from '../provider-conformance/index.js';
import { createRuntimeEvent, negotiateProviderCapabilities } from '../runtime-contracts/index.js';
import { createInMemoryRuntimeHostStore, createRuntimeEventBus, createRuntimeHost } from '../runtime-host/index.js';
import { createRuntimeArtifactStore, createRuntimePersistenceStore } from '../runtime-persistence/index.js';
import { createApprovalBridge, createToolDispatcher, createToolRegistry } from '../tool-fabric/index.js';

const cloneValue = (value) => JSON.parse(JSON.stringify(value));

const normalizeNow = (now) => {
  if (typeof now !== 'function') {
    return () => new Date().toISOString();
  }

  return () => {
    const timestamp = now();
    if (typeof timestamp !== 'string' || timestamp.trim().length === 0) {
      throw new Error('runtime-backend now() must return a non-empty ISO timestamp string');
    }
    return timestamp;
  };
};

const normalizeMetadata = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return cloneValue(value);
};

const normalizeCapabilityList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))];
};

const buildAvailableCapabilities = (capability) => {
  if (!capability || typeof capability !== 'object') {
    return [];
  }

  const output = [];
  if (capability.chat === true) output.push('chat');
  if (capability.streaming === true) output.push('streaming');
  if (capability.tools?.supported === true) output.push('tools');
  if (capability.structuredOutput && capability.structuredOutput !== 'unsupported') {
    output.push('structured-output');
  }
  return output;
};

const createAdapterForProvider = (providerID, options) => {
  if (providerID === 'openai') {
    return createOpenAiCompatibleAdapter(options);
  }

  if (providerID === 'litellm') {
    return createLiteLlmAdapter(options);
  }

  if (providerID === 'ollama') {
    return createOllamaAdapter(options);
  }

  return null;
};

export const createRuntimeBackend = ({
  fsPromises,
  path,
  baseDirectory,
  runtimeID = 'runtime-host',
  instanceID = 'runtime-host-instance',
  hostKind = 'web',
  now,
  logger = console,
  providerAdapterOptions = {},
} = {}) => {
  if (!fsPromises || !path) {
    throw new Error('createRuntimeBackend requires fsPromises and path dependencies');
  }

  const nowIso = normalizeNow(now);
  const eventBus = createRuntimeEventBus();
  const hostStore = createInMemoryRuntimeHostStore();
  const persistenceStore = createRuntimePersistenceStore({
    fsPromises,
    path,
    baseDirectory,
    runtimeID,
  });
  const artifactStore = createRuntimeArtifactStore({ fsPromises, path, baseDirectory });
  const policyEngine = createOmoPolicyEngine({ now: nowIso });

  let backendEventSequence = 0;
  let sessionCounter = 0;

  const host = createRuntimeHost({
    now: nowIso,
    store: hostStore,
    bus: eventBus,
    runtimeID,
    instanceID,
    hostKind,
  });

  const persistHostSnapshotAsync = () => {
    const snapshot = hostStore.load();
    if (!snapshot) {
      return;
    }
    void persistenceStore.save(snapshot).catch((error) => {
      logger.error?.('runtime-backend failed to persist snapshot', error);
    });
  };

  const appendRuntimeEventAsync = (event) => {
    void persistenceStore.append(event).catch((error) => {
      logger.error?.('runtime-backend failed to append event', error);
    });
  };

  const publishBackendEvent = ({ type, taskID, providerID, payload = {} }) => {
    backendEventSequence += 1;
    const event = createRuntimeEvent({
      type,
      runtimeID,
      taskID,
      providerID,
      occurredAt: nowIso(),
      payload: {
        eventID: `backend-evt-${String(backendEventSequence).padStart(4, '0')}`,
        eventSequence: backendEventSequence,
        ...cloneValue(payload),
      },
    });

    hostStore.append(event);
    eventBus.publish(event);
    appendRuntimeEventAsync(event);
    persistHostSnapshotAsync();
    return event;
  };

  host.subscribe((event) => {
    appendRuntimeEventAsync(event);
    persistHostSnapshotAsync();
  });
  persistHostSnapshotAsync();

  const approvalBridge = createApprovalBridge({ now: nowIso });
  const toolRegistry = createToolRegistry({
    tools: [
      {
        name: 'runtime.echo',
        permissionScope: 'runtime:echo',
        timeoutPolicy: { timeoutMs: 2_000 },
        requiresApproval: true,
        execute: ({ input }) => ({ echo: cloneValue(input) }),
      },
    ],
  });

  const toolDispatcher = createToolDispatcher({
    registry: toolRegistry,
    approvalBridge,
    now: nowIso,
    runtimeID,
    emitEvent: (event) => {
      hostStore.append(event);
      eventBus.publish(event);
      appendRuntimeEventAsync(event);
      persistHostSnapshotAsync();
    },
    hasPermission: () => true,
  });

  const activeCancellers = new Map();

  const createSession = (input = {}) => {
    sessionCounter += 1;
    const session = {
      sessionID: `runtime-session-${String(sessionCounter).padStart(4, '0')}`,
      runtimeID,
      createdAt: nowIso(),
      metadata: normalizeMetadata(input.metadata),
    };

    const policyAction = policyEngine.decideNextAction({
      taskState: {
        workflowID: session.sessionID,
        phase: 'planning',
      },
      recentRuntimeEvents: hostStore.getEvents().slice(-10),
    });

    return {
      session,
      host: host.getHostSnapshot(),
      policyAction,
    };
  };

  const negotiateProvider = (input = {}) => {
    const providerID = typeof input.providerID === 'string' ? input.providerID.trim() : '';
    if (!providerID) {
      throw new Error('providerID is required for capability negotiation');
    }

    const capabilityMatrix = normalizeCapabilityMatrix();
    const adapter = createAdapterForProvider(providerID, providerAdapterOptions);
    const providerCapability = capabilityMatrix[providerID] ?? adapter?.capabilities ?? null;
    const required = normalizeCapabilityList(input.requiredCapabilities);
    const degradable = normalizeCapabilityList(input.degradableCapabilities);
    const available = buildAvailableCapabilities(providerCapability);

    const negotiation = negotiateProviderCapabilities({
      required,
      available,
      degradable,
    });

    publishBackendEvent({
      type: 'provider.negotiated',
      providerID,
      payload: {
        providerID,
        outcome: negotiation.outcome,
        requiredCapabilities: required,
        availableCapabilities: available,
        missingCapabilities: negotiation.missingCapabilities,
        degradedCapabilities: negotiation.degradedCapabilities,
      },
    });

    return {
      providerID,
      outcome: negotiation.outcome,
      acceptedCapabilities: negotiation.acceptedCapabilities,
      missingCapabilities: negotiation.missingCapabilities,
      degradedCapabilities: negotiation.degradedCapabilities,
      reason: negotiation.reason,
      capabilitySnapshot: providerCapability,
      adapterSnapshot: adapter
        ? {
            providerID: adapter.providerID,
            supportsStreaming: adapter.supportsStreaming,
            supportsTools: adapter.supportsTools,
            supportsImages: adapter.supportsImages,
          }
        : null,
    };
  };

  const runTask = async (input = {}) => {
    const task = host.enqueueTask({ metadata: normalizeMetadata(input.metadata) });
    host.startTask(task.taskID);

    let negotiation = null;
    if (typeof input.providerID === 'string' && input.providerID.trim().length > 0) {
      negotiation = negotiateProvider({
        providerID: input.providerID,
        requiredCapabilities: input.requiredCapabilities,
        degradableCapabilities: input.degradableCapabilities,
      });
    }

    let toolResult = null;
    if (
      input.toolInvocation &&
      typeof input.toolInvocation === 'object' &&
      !Array.isArray(input.toolInvocation) &&
      Object.keys(input.toolInvocation).length > 0
    ) {
      const toolName =
        typeof input.toolInvocation.toolName === 'string' && input.toolInvocation.toolName.trim().length > 0
          ? input.toolInvocation.toolName.trim()
          : 'runtime.echo';

      const invocation = toolDispatcher.invokeTool({
        taskID: task.taskID,
        toolName,
        input: normalizeMetadata(input.toolInvocation.input),
        requiresApproval:
          typeof input.toolInvocation.requiresApproval === 'boolean' ? input.toolInvocation.requiresApproval : undefined,
      });

      activeCancellers.set(task.taskID, invocation.cancel);

      if (input.toolInvocation.autoApprove === true) {
        const pendingApprovals = approvalBridge.listPending();
        for (const approval of pendingApprovals) {
          if (approval.invocationID === invocation.invocationID) {
            approvalBridge.approve(approval.approvalID, { source: 'runtime-backend:auto-approve' });
          }
        }
      }

      const result = await invocation.result;
      activeCancellers.delete(task.taskID);

      toolResult = {
        invocationID: invocation.invocationID,
        status: result.status,
        ok: result.ok,
        output: result.output,
        error: result.error,
      };

      if (result.status === 'completed') {
        host.completeTask(task.taskID, {
          toolInvocation: {
            invocationID: invocation.invocationID,
            toolName,
            output: result.output,
          },
        });
      } else if (result.status === 'cancelled') {
        host.cancelTask(task.taskID, 'tool invocation cancelled');
      } else {
        host.completeTask(task.taskID, {
          toolInvocation: {
            invocationID: invocation.invocationID,
            toolName,
            error: result.error,
          },
        });
      }
    }

    return {
      task: host.getTask(task.taskID),
      negotiation,
      toolResult,
    };
  };

  const cancelTask = (taskID, reason = 'cancelled') => {
    const activeCanceller = activeCancellers.get(taskID);
    if (typeof activeCanceller === 'function') {
      activeCanceller(reason);
      activeCancellers.delete(taskID);
    }

    return host.cancelTask(taskID, reason);
  };

  return {
    createSession,
    runTask,
    cancelTask,
    subscribeEvents: (listener) => host.subscribe(listener),
    negotiateProvider,
    readArtifact: (category, fileName) => artifactStore.readArtifact(category, fileName),
    artifactStore,
    host,
  };
};
