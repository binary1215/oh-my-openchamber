import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { OMO_KERNEL_ENTRIES, VERTICAL_SLICE_ENTRYPOINTS } from '../omo-inventory/index.js';
import { createOmoPolicyEngine } from '../omo-policy/index.js';
import {
  createLiteLlmAdapter,
  createOllamaAdapter,
  createOpenAiCompatibleAdapter,
} from '../provider-adapters/index.js';
import { normalizeCapabilityMatrix } from '../provider-conformance/index.js';
import { negotiateProviderCapabilities } from '../runtime-contracts/index.js';
import { createRuntimeBackend } from '../runtime-backend/index.js';
import { replayRuntimeEvents } from '../runtime-persistence/index.js';
import { createInMemoryRuntimeHostStore, createRuntimeHost } from '../runtime-host/index.js';
import { createApprovalBridge, createToolDispatcher, createToolRegistry } from '../tool-fabric/index.js';

const cloneValue = (value) => JSON.parse(JSON.stringify(value));

const arrayEquals = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
};

const compareShape = ({ actual, expected, pathPrefix = 'root', mismatches = [] }) => {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      mismatches.push(`${pathPrefix}: expected array, received ${typeof actual}`);
      return mismatches;
    }

    if (actual.length !== expected.length) {
      mismatches.push(`${pathPrefix}: expected length ${expected.length}, received ${actual.length}`);
    }

    const length = Math.min(actual.length, expected.length);
    for (let index = 0; index < length; index += 1) {
      compareShape({
        actual: actual[index],
        expected: expected[index],
        pathPrefix: `${pathPrefix}[${index}]`,
        mismatches,
      });
    }

    return mismatches;
  }

  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      mismatches.push(`${pathPrefix}: expected object, received ${typeof actual}`);
      return mismatches;
    }

    for (const key of Object.keys(expected)) {
      compareShape({
        actual: actual[key],
        expected: expected[key],
        pathPrefix: `${pathPrefix}.${key}`,
        mismatches,
      });
    }

    return mismatches;
  }

  if (actual !== expected) {
    mismatches.push(`${pathPrefix}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }

  return mismatches;
};

const createDeterministicNow = (seed = '2026-04-02T08:00:00.000Z') => {
  let cursor = Date.parse(seed);
  if (!Number.isFinite(cursor)) {
    throw new Error('omo-parity createDeterministicNow requires an ISO seed timestamp');
  }

  return () => {
    const current = new Date(cursor).toISOString();
    cursor += 1_000;
    return current;
  };
};

const createProviderStubOptions = () => ({
  getProviderAuth: () => ({ apiKey: 'test-api-key' }),
  getProviderSources: () => ({
    sources: {
      auth: { exists: true },
      user: { exists: false, path: null },
      project: { exists: false, path: null },
      custom: { exists: false, path: null },
    },
  }),
  resolveOpenCodeEnvConfig: () => ({
    configuredOpenCodeHost: null,
    configuredOpenCodePort: null,
    effectivePort: null,
    configuredOpenCodeHostname: '127.0.0.1',
  }),
});

const collectEventEnvelope = (event) => ({
  type: event.type,
  taskID: event.taskID ?? null,
  providerID: event.providerID ?? null,
  eventSequence: event.payload?.eventSequence ?? null,
});

const runPlannerScenario = ({ fixture, now }) => {
  const engine = createOmoPolicyEngine({ now });
  const decision = engine.decideNextAction(fixture.input);

  return {
    action: decision.action,
    graphID: decision.taskGraph?.graphID ?? null,
    steps: (decision.taskGraph?.steps ?? []).map((step) => ({
      stepID: step.stepID,
      role: step.role,
      title: step.title,
    })),
    inventoryEntrypoints: VERTICAL_SLICE_ENTRYPOINTS.plan,
  };
};

const runDelegationScenario = ({ fixture, now }) => {
  const engine = createOmoPolicyEngine({ now });
  const decisions = fixture.inputs.map((input) => engine.decideNextAction(input));

  return {
    delegations: decisions.map((decision) => ({
      action: decision.action,
      delegationID: decision.delegation?.delegationID ?? null,
      taskID: decision.delegation?.taskID ?? null,
      targetRole: decision.delegation?.targetRole ?? null,
    })),
  };
};

const runContinuationScenario = ({ fixture, now }) => {
  const engine = createOmoPolicyEngine({ now });
  const decision = engine.decideNextAction(fixture.input);
  return {
    action: decision.action,
    continuationReason: decision.continuationReason ?? null,
  };
};

const runToolExecutionScenario = async ({ fixture, now }) => {
  const events = [];
  const registry = createToolRegistry({
    tools: [
      {
        name: 'runtime.echo',
        permissionScope: 'runtime:echo',
        timeoutPolicy: { timeoutMs: 1000 },
        resultSchema: { type: 'object' },
        execute: ({ input }) => ({
          echoed: cloneValue(input),
          mode: 'deterministic',
        }),
      },
    ],
  });
  const dispatcher = createToolDispatcher({
    registry,
    approvalBridge: createApprovalBridge({ now }),
    now,
    runtimeID: 'runtime-omo-parity-tool',
    emitEvent: (event) => events.push(event),
  });

  const invocation = dispatcher.invokeTool({
    taskID: fixture.input.taskID,
    toolName: fixture.input.toolName,
    input: fixture.input.payload,
  });
  const result = await invocation.result;

  return {
    result: {
      status: result.status,
      ok: result.ok,
      output: result.output,
    },
    invocation: {
      taskID: fixture.input.taskID,
      toolName: fixture.input.toolName,
      payload: fixture.input.payload,
    },
    events: events.map(collectEventEnvelope),
  };
};

const runCancellationScenario = ({ fixture, now }) => {
  const store = createInMemoryRuntimeHostStore();
  const host = createRuntimeHost({
    now,
    store,
    runtimeID: 'runtime-omo-parity-cancel',
    instanceID: 'instance-omo-parity-cancel',
  });
  const events = [];
  host.subscribe((event) => events.push(event));

  const task = host.enqueueTask({ metadata: fixture.input.metadata });
  host.startTask(task.taskID);
  host.cancelTask(task.taskID, fixture.input.reason);
  host.cancelTask(task.taskID, 'duplicate-cancel');

  return {
    task: {
      taskID: task.taskID,
      status: host.getTask(task.taskID)?.status ?? null,
      cancelReason: host.getTask(task.taskID)?.cancelReason ?? null,
    },
    events: events.map(collectEventEnvelope),
  };
};

const runReplayRecoveryScenario = ({ fixture, now }) => {
  const store = createInMemoryRuntimeHostStore();
  const host = createRuntimeHost({
    now,
    store,
    runtimeID: 'runtime-omo-parity-replay',
    instanceID: 'instance-omo-parity-replay',
  });

  const firstTask = host.enqueueTask({ metadata: { flow: 'recover' } });
  host.startTask(firstTask.taskID);
  host.completeTask(firstTask.taskID, { ok: true });
  const secondTask = host.enqueueTask({ metadata: { flow: 'recover-cancel' } });
  host.cancelTask(secondTask.taskID, 'operator-stop');

  const replay = replayRuntimeEvents(store.getEvents());

  return {
    host: {
      runtimeID: replay.host?.runtimeID ?? null,
      status: replay.host?.status ?? null,
    },
    tasks: replay.tasks.map((task) => ({ taskID: task.taskID, status: task.status })),
    counters: replay.counters,
    replayEventCount: store.getEvents().length,
    expectedReplayEventCount: fixture.expectedReplayEventCount,
  };
};

const validateProviderDegradation = (actual, expected) => {
  const missingMatches = arrayEquals(actual.missingCapabilities, expected.missingCapabilities);
  const degradedMatches = arrayEquals(actual.degradedCapabilities, expected.degradedCapabilities);
  const outcomeMatches = actual.outcome === expected.outcome;

  if (!missingMatches || !degradedMatches || !outcomeMatches) {
    throw new Error(
      `Provider degradation capability loss mismatch: expected outcome=${expected.outcome}, missing=${JSON.stringify(
        expected.missingCapabilities,
      )}, degraded=${JSON.stringify(expected.degradedCapabilities)} but received outcome=${actual.outcome}, missing=${JSON.stringify(
        actual.missingCapabilities,
      )}, degraded=${JSON.stringify(actual.degradedCapabilities)}`,
    );
  }
};

const runProviderDegradationScenario = async ({ fixture, now, runtimeID, instanceID, baseDirectory, fs, pathModule }) => {
  const backendEvents = [];
  const backend = createRuntimeBackend({
    fsPromises: fs,
    path: pathModule,
    baseDirectory,
    now,
    runtimeID,
    instanceID,
    providerAdapterOptions: createProviderStubOptions(),
  });

  backend.subscribeEvents((event) => backendEvents.push(event));
  const run = await backend.runTask(fixture.input);

  validateProviderDegradation(run.negotiation, fixture.expected.negotiation);

  return {
    task: {
      status: run.task?.status ?? null,
    },
    toolResult: {
      status: run.toolResult?.status ?? null,
      ok: run.toolResult?.ok ?? null,
    },
    negotiation: {
      outcome: run.negotiation?.outcome ?? null,
      missingCapabilities: run.negotiation?.missingCapabilities ?? [],
      degradedCapabilities: run.negotiation?.degradedCapabilities ?? [],
    },
    events: backendEvents.map(collectEventEnvelope),
  };
};

const runProviderRegressionScenario = ({ fixture }) => {
  const matrix = normalizeCapabilityMatrix();
  const options = createProviderStubOptions();
  const adapters = {
    openai: createOpenAiCompatibleAdapter(options),
    litellm: createLiteLlmAdapter(options),
    ollama: createOllamaAdapter(options),
  };

  const rows = Object.keys(adapters)
    .sort()
    .map((providerID) => {
      const adapter = adapters[providerID];
      const capability = matrix[providerID];
      const chatPath = adapter.buildChatRequest({ model: 'model', messages: [] }).path;
      const modelsPath = adapter.buildModelsListRequest().path;
      const negotiation = negotiateProviderCapabilities({
        required: ['chat', 'tools', 'images'],
        available: [
          capability.chat ? 'chat' : null,
          capability.tools.supported ? 'tools' : null,
          adapter.supportsImages ? 'images' : null,
        ].filter(Boolean),
        degradable: ['images'],
      });

      return {
        providerID,
        streamProtocol: capability.streamProtocol,
        toolCallArguments: capability.tools.toolCallArguments,
        chatPath,
        modelsPath,
        negotiationOutcome: negotiation.outcome,
      };
    });

  return {
    providers: rows,
    inventoryEntryCount: OMO_KERNEL_ENTRIES.length,
    expectedInventoryEntryCount: fixture.expectedInventoryEntryCount,
  };
};

const runScenarioByType = async ({ fixture, now, runtimeID, instanceID, baseDirectory, fs, pathModule }) => {
  switch (fixture.type) {
    case 'planner-flow':
      return runPlannerScenario({ fixture, now });
    case 'delegation':
      return runDelegationScenario({ fixture, now });
    case 'continuation':
      return runContinuationScenario({ fixture, now });
    case 'tool-execution':
      return runToolExecutionScenario({ fixture, now });
    case 'cancellation':
      return runCancellationScenario({ fixture, now });
    case 'replay-recovery':
      return runReplayRecoveryScenario({ fixture, now });
    case 'provider-degradation':
      return runProviderDegradationScenario({ fixture, now, runtimeID, instanceID, baseDirectory, fs, pathModule });
    case 'provider-regression-matrix':
      return runProviderRegressionScenario({ fixture });
    default:
      throw new Error(`Unsupported OMO parity scenario type: ${String(fixture.type)}`);
  }
};

export const createOmoParityHarness = ({
  now = createDeterministicNow(),
  fs = fsPromises,
  pathModule = path,
  baseDirectory,
  runtimeID = 'runtime-omo-parity',
  instanceID = 'instance-omo-parity',
} = {}) => {
  const runScenario = async (fixture) => {
    if (!fixture || typeof fixture !== 'object') {
      throw new Error('runScenario requires a fixture object');
    }

    const actual = await runScenarioByType({
      fixture,
      now,
      runtimeID,
      instanceID,
      baseDirectory,
      fs,
      pathModule,
    });

    const mismatches = compareShape({ actual, expected: fixture.expected });
    return {
      scenario: fixture.scenario,
      type: fixture.type,
      ok: mismatches.length === 0,
      mismatches,
      actual,
      expected: cloneValue(fixture.expected),
    };
  };

  return {
    runScenario,
  };
};

export const runOmoParityScenario = async ({ fixture, ...options } = {}) => {
  const harness = createOmoParityHarness(options);
  return harness.runScenario(fixture);
};
