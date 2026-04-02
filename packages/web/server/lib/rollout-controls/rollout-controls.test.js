import { describe, expect, it } from 'bun:test';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntimeBackend } from '../runtime-backend/index.js';
import { createRuntimeRolloutController, resolveRuntimeRolloutConfig } from './index.js';

const createTempDirectory = async () => fsPromises.mkdtemp(path.join(os.tmpdir(), 'rollout-controls-'));

const createProviderAdapterOptions = () => ({
  getProviderAuth: () => ({ apiKey: 'test-api-key' }),
  getProviderSources: () => ({ sources: { auth: { exists: true } } }),
  resolveOpenCodeEnvConfig: () => ({ configuredOpenCodeHost: null }),
});

describe('rollout controls', () => {
  it('keeps baseline runtime usable with all transplant flags disabled', async () => {
    const rolloutConfig = resolveRuntimeRolloutConfig({
      env: {
        OPENCHAMBER_RUNTIME_TRANSPLANT_ENABLED: 'false',
        OPENCHAMBER_RUNTIME_PROVIDER_ADAPTERS_ENABLED: 'false',
        OPENCHAMBER_RUNTIME_ADVANCED_OMO_ENABLED: 'false',
      },
    });

    const backend = createRuntimeBackend({
      fsPromises,
      path,
      baseDirectory: await createTempDirectory(),
      rolloutConfig,
      providerAdapterOptions: createProviderAdapterOptions(),
    });

    const session = backend.createSession({ metadata: { scenario: 'all-flags-off' } });
    expect(session.policyAction.action).toBe('fallback_to_baseline');

    const run = await backend.runTask({
      metadata: { scenario: 'all-flags-off' },
      providerID: 'openai',
      requiredCapabilities: ['chat'],
      toolInvocation: {
        toolName: 'runtime.echo',
        input: { keep: 'usable' },
        requiresApproval: true,
        autoApprove: true,
      },
    });

    expect(run.task.status).toBe('completed');
    expect(run.negotiation).toBeNull();
    expect(run.toolResult).toBeNull();

    const rollout = backend.getRolloutStatus();
    expect(rollout.effectiveFlags.runtimeTransplantEnabled).toBe(false);
    expect(rollout.effectiveFlags.providerAdaptersEnabled).toBe(false);
    expect(rollout.effectiveFlags.advancedOmoBehaviorsEnabled).toBe(false);
    expect(rollout.metrics.model_calls).toBe(1);
  });

  it('supports runtime on with provider adapters off', async () => {
    const rolloutConfig = resolveRuntimeRolloutConfig({
      env: {
        OPENCHAMBER_RUNTIME_TRANSPLANT_ENABLED: 'true',
        OPENCHAMBER_RUNTIME_PROVIDER_ADAPTERS_ENABLED: 'false',
        OPENCHAMBER_RUNTIME_ADVANCED_OMO_ENABLED: 'true',
      },
    });

    const backend = createRuntimeBackend({
      fsPromises,
      path,
      baseDirectory: await createTempDirectory(),
      rolloutConfig,
      providerAdapterOptions: createProviderAdapterOptions(),
    });

    const negotiation = backend.negotiateProvider({
      providerID: 'openai',
      requiredCapabilities: ['chat', 'images'],
      degradableCapabilities: ['images'],
    });

    expect(negotiation.outcome).toBe('degrade');
    expect(negotiation.adapterSnapshot).toBeNull();
    expect(negotiation.rollout.effectiveFlags.runtimeTransplantEnabled).toBe(true);
    expect(negotiation.rollout.effectiveFlags.providerAdaptersEnabled).toBe(false);
  });

  it('runs full enablement with model/tool/cancel/retry metrics', async () => {
    const backend = createRuntimeBackend({
      fsPromises,
      path,
      baseDirectory: await createTempDirectory(),
      rolloutConfig: resolveRuntimeRolloutConfig({
        env: {
          OPENCHAMBER_RUNTIME_TRANSPLANT_ENABLED: 'true',
          OPENCHAMBER_RUNTIME_PROVIDER_ADAPTERS_ENABLED: 'true',
          OPENCHAMBER_RUNTIME_ADVANCED_OMO_ENABLED: 'true',
        },
      }),
      providerAdapterOptions: createProviderAdapterOptions(),
    });

    const run = await backend.runTask({
      metadata: { scenario: 'full-enablement' },
      retry: true,
      providerID: 'openai',
      requiredCapabilities: ['chat', 'tools', 'images'],
      degradableCapabilities: ['images'],
      toolInvocation: {
        toolName: 'runtime.echo',
        input: { hello: 'rollout' },
        requiresApproval: true,
        autoApprove: true,
      },
    });

    expect(run.task.status).toBe('completed');
    expect(run.negotiation.outcome).toBe('degrade');
    expect(run.toolResult.status).toBe('completed');

    const longTask = await backend.runTask({ metadata: { scenario: 'cancel' } });
    expect(longTask.task.status).toBe('running');
    const cancelled = backend.cancelTask(longTask.task.taskID, 'test-cancel');
    expect(cancelled.status).toBe('cancelled');

    const rollout = backend.getRolloutStatus();
    expect(rollout.metrics.model_calls).toBeGreaterThanOrEqual(2);
    expect(rollout.metrics.tool_calls).toBe(1);
    expect(rollout.metrics.retries).toBe(1);
    expect(rollout.metrics.cancellations).toBe(1);
  });

  it('trips rollback after deterministic failure budget breach', async () => {
    const backend = createRuntimeBackend({
      fsPromises,
      path,
      baseDirectory: await createTempDirectory(),
      rolloutConfig: resolveRuntimeRolloutConfig({
        env: {
          OPENCHAMBER_RUNTIME_TRANSPLANT_ENABLED: 'true',
          OPENCHAMBER_RUNTIME_PROVIDER_ADAPTERS_ENABLED: 'true',
          OPENCHAMBER_RUNTIME_ADVANCED_OMO_ENABLED: 'true',
          OPENCHAMBER_RUNTIME_FAILURE_BUDGET_MAX_FAILURES: '2',
          OPENCHAMBER_RUNTIME_ROLLBACK_ON_FAILURE_BUDGET: 'true',
        },
      }),
      providerAdapterOptions: createProviderAdapterOptions(),
    });

    const first = backend.negotiateProvider({
      providerID: 'unknown-provider',
      requiredCapabilities: ['chat'],
    });
    expect(first.outcome).toBe('refuse');

    const second = backend.negotiateProvider({
      providerID: 'unknown-provider',
      requiredCapabilities: ['chat'],
    });
    expect(second.outcome).toBe('refuse');

    const statusAfterBreach = backend.getRolloutStatus();
    expect(statusAfterBreach.failureCount).toBe(2);
    expect(statusAfterBreach.rollbackTripCount).toBe(1);
    expect(statusAfterBreach.effectiveFlags.runtimeTransplantEnabled).toBe(false);
    expect(statusAfterBreach.metrics.provider_negotiation_failures).toBe(2);
    expect(statusAfterBreach.metrics.rollback_activations).toBe(1);

    const runAfterRollback = await backend.runTask({
      metadata: { scenario: 'after-rollback' },
      providerID: 'openai',
      requiredCapabilities: ['chat'],
    });

    expect(runAfterRollback.task.status).toBe('completed');
    expect(runAfterRollback.negotiation).toBeNull();
    expect(runAfterRollback.rollout.effectiveFlags.runtimeTransplantEnabled).toBe(false);
  });

  it('exposes explicit rollout metrics/traces through controller surface', () => {
    const controller = createRuntimeRolloutController({
      config: {
        flags: {
          runtimeTransplantEnabled: true,
          providerAdaptersEnabled: true,
          advancedOmoBehaviorsEnabled: true,
        },
        failureBudget: {
          maxFailures: 1,
          rollbackOnBudgetBreach: true,
        },
      },
    });

    controller.recordMetric({ type: 'model.call', payload: { source: 'unit-test' } });
    controller.recordFailure({ reason: 'unit-test-failure' });

    const status = controller.getState();
    expect(status.metrics.model_calls).toBe(1);
    expect(status.metrics.rollback_activations).toBe(1);
    expect(status.effectiveFlags.runtimeTransplantEnabled).toBe(false);
    expect(status.traceEvents.some((event) => event.event === 'rollback.activated')).toBe(true);
  });
});
