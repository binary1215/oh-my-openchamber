const DEFAULT_RUNTIME_ROLLOUT_FLAGS = Object.freeze({
  runtimeTransplantEnabled: true,
  providerAdaptersEnabled: true,
  advancedOmoBehaviorsEnabled: true,
});

const DEFAULT_FAILURE_BUDGET = Object.freeze({
  maxFailures: 3,
  rollbackOnBudgetBreach: true,
});

const METRIC_KEYS = Object.freeze({
  modelCalls: 'model_calls',
  toolCalls: 'tool_calls',
  cancellations: 'cancellations',
  retries: 'retries',
  providerNegotiationFailures: 'provider_negotiation_failures',
  rollbackActivations: 'rollback_activations',
});

const MAX_TRACE_EVENTS = 200;

const clone = (value) => JSON.parse(JSON.stringify(value));

const parseBooleanFlag = ({ env, key, fallback }) => {
  const raw = env[key];
  if (typeof raw !== 'string') {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
};

const parsePositiveInteger = ({ env, key, fallback, minimum = 1, logger }) => {
  const raw = env[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    logger.warn?.(
      `[rollout-controls] Ignoring ${key}=${JSON.stringify(raw)}: must be an integer >= ${minimum}`,
    );
    return fallback;
  }

  return parsed;
};

const createInitialMetricCounters = () => ({
  [METRIC_KEYS.modelCalls]: 0,
  [METRIC_KEYS.toolCalls]: 0,
  [METRIC_KEYS.cancellations]: 0,
  [METRIC_KEYS.retries]: 0,
  [METRIC_KEYS.providerNegotiationFailures]: 0,
  [METRIC_KEYS.rollbackActivations]: 0,
});

export const resolveRuntimeRolloutConfig = ({ env = {}, logger = console } = {}) => {
  const flags = {
    runtimeTransplantEnabled: parseBooleanFlag({
      env,
      key: 'OPENCHAMBER_RUNTIME_TRANSPLANT_ENABLED',
      fallback: DEFAULT_RUNTIME_ROLLOUT_FLAGS.runtimeTransplantEnabled,
    }),
    providerAdaptersEnabled: parseBooleanFlag({
      env,
      key: 'OPENCHAMBER_RUNTIME_PROVIDER_ADAPTERS_ENABLED',
      fallback: DEFAULT_RUNTIME_ROLLOUT_FLAGS.providerAdaptersEnabled,
    }),
    advancedOmoBehaviorsEnabled: parseBooleanFlag({
      env,
      key: 'OPENCHAMBER_RUNTIME_ADVANCED_OMO_ENABLED',
      fallback: DEFAULT_RUNTIME_ROLLOUT_FLAGS.advancedOmoBehaviorsEnabled,
    }),
  };

  const failureBudget = {
    maxFailures: parsePositiveInteger({
      env,
      key: 'OPENCHAMBER_RUNTIME_FAILURE_BUDGET_MAX_FAILURES',
      fallback: DEFAULT_FAILURE_BUDGET.maxFailures,
      minimum: 1,
      logger,
    }),
    rollbackOnBudgetBreach: parseBooleanFlag({
      env,
      key: 'OPENCHAMBER_RUNTIME_ROLLBACK_ON_FAILURE_BUDGET',
      fallback: DEFAULT_FAILURE_BUDGET.rollbackOnBudgetBreach,
    }),
  };

  return {
    flags,
    failureBudget,
    source: 'env',
  };
};

export const createRuntimeRolloutController = ({ config = {}, now = Date.now, logger = console } = {}) => {
  const resolvedConfig = {
    flags: {
      ...DEFAULT_RUNTIME_ROLLOUT_FLAGS,
      ...(config.flags && typeof config.flags === 'object' ? config.flags : {}),
    },
    failureBudget: {
      ...DEFAULT_FAILURE_BUDGET,
      ...(config.failureBudget && typeof config.failureBudget === 'object' ? config.failureBudget : {}),
    },
    source: typeof config.source === 'string' && config.source.trim().length > 0 ? config.source : 'default',
  };

  const effectiveFlags = {
    runtimeTransplantEnabled: resolvedConfig.flags.runtimeTransplantEnabled === true,
    providerAdaptersEnabled: resolvedConfig.flags.providerAdaptersEnabled === true,
    advancedOmoBehaviorsEnabled: resolvedConfig.flags.advancedOmoBehaviorsEnabled === true,
  };

  const metrics = createInitialMetricCounters();
  const traces = [];
  let failureCount = 0;
  let rollbackTripCount = 0;
  let rollbackReason = null;

  const pushTraceEvent = (event, payload = {}) => {
    traces.push({
      event,
      occurredAt: new Date(now()).toISOString(),
      payload: clone(payload),
    });

    if (traces.length > MAX_TRACE_EVENTS) {
      traces.shift();
    }
  };

  const incrementCounter = (counterKey) => {
    if (!Object.prototype.hasOwnProperty.call(metrics, counterKey)) {
      return;
    }
    metrics[counterKey] += 1;
  };

  const activateRollback = ({ reason, details = {} } = {}) => {
    if (!effectiveFlags.runtimeTransplantEnabled) {
      return false;
    }

    effectiveFlags.runtimeTransplantEnabled = false;
    effectiveFlags.providerAdaptersEnabled = false;
    effectiveFlags.advancedOmoBehaviorsEnabled = false;
    rollbackTripCount += 1;
    rollbackReason = typeof reason === 'string' && reason.trim().length > 0 ? reason : 'failure_budget_breached';

    incrementCounter(METRIC_KEYS.rollbackActivations);
    pushTraceEvent('rollback.activated', {
      reason: rollbackReason,
      failureBudget: clone(resolvedConfig.failureBudget),
      failureCount,
      details,
    });

    logger.warn?.(
      `[rollout-controls] Runtime transplant rolled back after ${failureCount} failure(s): ${rollbackReason}`,
    );

    return true;
  };

  const recordFailure = ({ reason, details = {} } = {}) => {
    failureCount += 1;
    pushTraceEvent('failure.recorded', {
      reason: typeof reason === 'string' && reason.trim().length > 0 ? reason : 'failure',
      details,
      failureCount,
    });

    const shouldRollback =
      resolvedConfig.failureBudget.rollbackOnBudgetBreach === true &&
      failureCount >= resolvedConfig.failureBudget.maxFailures;

    if (!shouldRollback) {
      return {
        rollbackActivated: false,
        failureCount,
      };
    }

    const rollbackActivated = activateRollback({ reason, details });
    return {
      rollbackActivated,
      failureCount,
    };
  };

  const recordMetric = ({ type, payload = {} } = {}) => {
    switch (type) {
      case 'model.call':
        incrementCounter(METRIC_KEYS.modelCalls);
        break;
      case 'tool.call':
        incrementCounter(METRIC_KEYS.toolCalls);
        break;
      case 'task.cancel':
        incrementCounter(METRIC_KEYS.cancellations);
        break;
      case 'task.retry':
        incrementCounter(METRIC_KEYS.retries);
        break;
      case 'provider.negotiation.failed':
        incrementCounter(METRIC_KEYS.providerNegotiationFailures);
        break;
      case 'rollback.activated':
        incrementCounter(METRIC_KEYS.rollbackActivations);
        break;
      default:
        break;
    }

    pushTraceEvent(type || 'unknown', payload);
  };

  return {
    isRuntimeTransplantEnabled: () => effectiveFlags.runtimeTransplantEnabled,
    areProviderAdaptersEnabled: () => effectiveFlags.runtimeTransplantEnabled && effectiveFlags.providerAdaptersEnabled,
    areAdvancedOmoBehaviorsEnabled: () => effectiveFlags.runtimeTransplantEnabled && effectiveFlags.advancedOmoBehaviorsEnabled,
    recordMetric,
    recordFailure,
    activateRollback,
    getState: () => ({
      config: clone(resolvedConfig),
      effectiveFlags: clone(effectiveFlags),
      failureCount,
      rollbackTripCount,
      rollbackReason,
      metrics: clone(metrics),
      traceEvents: clone(traces),
    }),
  };
};

export { METRIC_KEYS };
