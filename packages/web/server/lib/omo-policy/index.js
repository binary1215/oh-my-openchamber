export const POLICY_PACK_VERSION = 'omo.policy.v1';
export const HANDOFF_SUMMARY_VERSION = 'omo.handoff.v1';

export const OMO_POLICY_ACTION = Object.freeze({
  CREATE_PLAN: 'create_plan',
  DELEGATE_TASK: 'delegate_task',
  CONTINUE_LOOP: 'continue_loop',
  STOP_LOOP: 'stop_loop',
  EMIT_HANDOFF: 'emit_handoff',
});

const DEFAULT_TASK_GRAPH_TEMPLATE = Object.freeze([
  Object.freeze({ role: 'planner', title: 'Draft execution plan' }),
  Object.freeze({ role: 'executor', title: 'Execute implementation tasks' }),
  Object.freeze({ role: 'reviewer', title: 'Review and verify outcomes' }),
]);

export const DEFAULT_OMO_POLICY_PACK = Object.freeze({
  version: POLICY_PACK_VERSION,
  prompts: Object.freeze({
    planner:
      'You are the planner. Produce an explicit, auditable task graph with deterministic sequencing and no hidden assumptions.',
    executor:
      'You are the executor. Complete delegated tasks directly, verify results, and report concrete outcomes without scope expansion.',
    reviewer:
      'You are the reviewer. Validate behavior against acceptance criteria and emit clear approve/reject reasoning with actionable findings.',
  }),
  ruleTables: Object.freeze({
    taskGraphTemplate: DEFAULT_TASK_GRAPH_TEMPLATE,
    delegation: Object.freeze({ maxDelegationsPerDecision: 1 }),
    continuation: Object.freeze({ requireProgressWithinIterations: 2 }),
  }),
  stopConditions: Object.freeze({
    maxIterations: 6,
    maxConsecutiveNoProgress: 2,
    guardrailEventTypes: Object.freeze(['provider.error', 'task.failed', 'task.cancelled']),
    terminalPhases: Object.freeze(['completed', 'failed', 'cancelled']),
  }),
});

const cloneValue = (value) => JSON.parse(JSON.stringify(value));

const normalizeNow = (now) => {
  if (typeof now !== 'function') {
    throw new Error('createOmoPolicyEngine requires a now() function returning an ISO timestamp');
  }

  return () => {
    const timestamp = now();
    if (typeof timestamp !== 'string' || timestamp.trim().length === 0) {
      throw new Error('omo-policy now() must return a non-empty ISO timestamp string');
    }
    return timestamp;
  };
};

const validatePolicyPack = (policyPack) => {
  if (!policyPack || typeof policyPack !== 'object') {
    throw new Error('createOmoPolicyEngine requires a policyPack object');
  }

  if (policyPack.version !== POLICY_PACK_VERSION) {
    throw new Error(
      `Unsupported policy pack version: expected ${POLICY_PACK_VERSION}, received ${String(policyPack.version)}`
    );
  }

  if (!policyPack.prompts || typeof policyPack.prompts !== 'object') {
    throw new Error('Policy pack must include prompts');
  }

  if (!policyPack.ruleTables || typeof policyPack.ruleTables !== 'object') {
    throw new Error('Policy pack must include ruleTables');
  }

  if (!policyPack.stopConditions || typeof policyPack.stopConditions !== 'object') {
    throw new Error('Policy pack must include stopConditions');
  }
};

const ensureObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const ensureArray = (value) => (Array.isArray(value) ? value : []);

const stableID = (prefix, counter) => `${prefix}-${String(counter).padStart(4, '0')}`;

const sortUniqueStrings = (items) =>
  [...new Set(items.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))].sort();

const buildTaskGraph = (taskState, policyPack, nextStepID) => {
  const requestedSteps = ensureArray(taskState.requestedSteps);
  const template = requestedSteps.length > 0 ? requestedSteps : policyPack.ruleTables.taskGraphTemplate;
  const workflowID = typeof taskState.workflowID === 'string' && taskState.workflowID.length > 0 ? taskState.workflowID : 'workflow-0001';

  const steps = [];
  for (const templateStep of template) {
    const normalized = ensureObject(templateStep);
    const role = typeof normalized.role === 'string' && normalized.role.length > 0 ? normalized.role : 'executor';
    const title =
      typeof normalized.title === 'string' && normalized.title.length > 0
        ? normalized.title
        : `Execute ${role} task`;

    steps.push({
      stepID: nextStepID(),
      role,
      title,
      prompt: policyPack.prompts[role] ?? policyPack.prompts.executor,
    });
  }

  return {
    graphID: `${workflowID}-graph-001`,
    workflowID,
    steps,
  };
};

export const buildHandoffSummary = ({ taskState, recentEvents, now }) => {
  const normalizedTaskState = ensureObject(taskState);
  const normalizedRecentEvents = ensureArray(recentEvents).map((event) => ensureObject(event));
  const normalizedNow = normalizeNow(now);

  const workflowID =
    typeof normalizedTaskState.workflowID === 'string' && normalizedTaskState.workflowID.length > 0
      ? normalizedTaskState.workflowID
      : 'workflow-0001';

  const completedTaskIDs = sortUniqueStrings(
    ensureArray(normalizedTaskState.completedTaskIDs).concat(
      ensureArray(normalizedTaskState.tasks)
        .map((task) => ensureObject(task))
        .filter((task) => task.status === 'completed')
        .map((task) => task.taskID)
    )
  );

  const outstandingTaskIDs = sortUniqueStrings(
    ensureArray(normalizedTaskState.outstandingTaskIDs).concat(
      ensureArray(normalizedTaskState.tasks)
        .map((task) => ensureObject(task))
        .filter((task) => task.status && task.status !== 'completed')
        .map((task) => task.taskID)
    )
  );

  const issueCodes = sortUniqueStrings(
    ensureArray(normalizedTaskState.issueCodes).concat(
      normalizedRecentEvents
        .map((event) => ensureObject(event.payload))
        .map((payload) => payload.code)
    )
  );

  const nextOwner =
    typeof normalizedTaskState.nextOwner === 'string' && normalizedTaskState.nextOwner.length > 0
      ? normalizedTaskState.nextOwner
      : 'reviewer';

  return {
    schemaVersion: HANDOFF_SUMMARY_VERSION,
    workflowID,
    createdAt: normalizedNow(),
    nextOwner,
    completedTaskIDs,
    outstandingTaskIDs,
    issueCodes,
    narrative: `Workflow ${workflowID}: ${completedTaskIDs.length} completed, ${outstandingTaskIDs.length} outstanding.`,
  };
};

const evaluateStopCondition = ({ taskState, recentEvents, policyPack }) => {
  const stopConditions = policyPack.stopConditions;
  const phase = typeof taskState.phase === 'string' ? taskState.phase : 'unknown';

  if (phase === 'handoff') {
    return { shouldStop: false, reason: null };
  }

  if (taskState.stopRequested === true) {
    return { shouldStop: true, reason: 'manual_stop_requested' };
  }

  if (stopConditions.terminalPhases.includes(phase)) {
    return { shouldStop: true, reason: `terminal_phase:${phase}` };
  }

  const guardrailHit = recentEvents.find((event) => stopConditions.guardrailEventTypes.includes(event.type));
  if (guardrailHit) {
    return { shouldStop: true, reason: `guardrail_event:${guardrailHit.type}` };
  }

  const iteration = Number.isInteger(taskState.iteration) ? taskState.iteration : 0;
  if (iteration >= stopConditions.maxIterations) {
    return { shouldStop: true, reason: 'max_iterations_reached' };
  }

  const noProgressCount = Number.isInteger(taskState.noProgressCount) ? taskState.noProgressCount : 0;
  if (noProgressCount >= stopConditions.maxConsecutiveNoProgress) {
    return { shouldStop: true, reason: 'max_no_progress_reached' };
  }

  return { shouldStop: false, reason: null };
};

export function createOmoPolicyEngine({ now = () => new Date().toISOString(), policyPack = DEFAULT_OMO_POLICY_PACK } = {}) {
  const nowISO = normalizeNow(now);
  validatePolicyPack(policyPack);

  let actionCounter = 0;
  let stepCounter = 0;
  let delegationCounter = 0;

  const nextActionID = () => {
    actionCounter += 1;
    return stableID('action', actionCounter);
  };

  const nextStepID = () => {
    stepCounter += 1;
    return stableID('step', stepCounter);
  };

  const nextDelegationID = () => {
    delegationCounter += 1;
    return stableID('delegation', delegationCounter);
  };

  const decideNextAction = (input) => {
    const normalizedInput = ensureObject(input);
    const taskState = ensureObject(normalizedInput.taskState);
    const recentEvents = ensureArray(normalizedInput.recentRuntimeEvents).map((event) => ensureObject(event));

    const stopEvaluation = evaluateStopCondition({ taskState, recentEvents, policyPack });
    if (stopEvaluation.shouldStop) {
      return {
        actionID: nextActionID(),
        schemaVersion: POLICY_PACK_VERSION,
        action: OMO_POLICY_ACTION.STOP_LOOP,
        stopReason: stopEvaluation.reason,
        decidedAt: nowISO(),
      };
    }

    const phase = typeof taskState.phase === 'string' ? taskState.phase : 'planning';

    if (phase === 'planning') {
      return {
        actionID: nextActionID(),
        schemaVersion: POLICY_PACK_VERSION,
        action: OMO_POLICY_ACTION.CREATE_PLAN,
        taskGraph: buildTaskGraph(taskState, policyPack, nextStepID),
        decidedAt: nowISO(),
      };
    }

    if (phase === 'delegating') {
      const pendingDelegations = ensureArray(taskState.pendingDelegations).map((item) => ensureObject(item));
      if (pendingDelegations.length === 0) {
        return {
          actionID: nextActionID(),
          schemaVersion: POLICY_PACK_VERSION,
          action: OMO_POLICY_ACTION.CONTINUE_LOOP,
          continuationReason: 'waiting_for_new_delegations',
          decidedAt: nowISO(),
        };
      }

      const nextDelegation = pendingDelegations[0];
      const role = typeof nextDelegation.role === 'string' && nextDelegation.role.length > 0 ? nextDelegation.role : 'executor';
      const taskID =
        typeof nextDelegation.taskID === 'string' && nextDelegation.taskID.length > 0
          ? nextDelegation.taskID
          : stableID('task', delegationCounter + 1);

      return {
        actionID: nextActionID(),
        schemaVersion: POLICY_PACK_VERSION,
        action: OMO_POLICY_ACTION.DELEGATE_TASK,
        delegation: {
          delegationID: nextDelegationID(),
          taskID,
          targetRole: role,
          title:
            typeof nextDelegation.title === 'string' && nextDelegation.title.length > 0
              ? nextDelegation.title
              : `Delegated ${role} task`,
          prompt: policyPack.prompts[role] ?? policyPack.prompts.executor,
        },
        decidedAt: nowISO(),
      };
    }

    if (phase === 'handoff') {
      return {
        actionID: nextActionID(),
        schemaVersion: POLICY_PACK_VERSION,
        action: OMO_POLICY_ACTION.EMIT_HANDOFF,
        handoffSummary: buildHandoffSummary({ taskState, recentEvents, now: nowISO }),
        decidedAt: nowISO(),
      };
    }

    return {
      actionID: nextActionID(),
      schemaVersion: POLICY_PACK_VERSION,
      action: OMO_POLICY_ACTION.CONTINUE_LOOP,
      continuationReason: 'no_transition_rule_matched',
      decidedAt: nowISO(),
    };
  };

  return {
    policyPackVersion: POLICY_PACK_VERSION,
    policyPack: cloneValue(policyPack),
    decideNextAction,
  };
}
