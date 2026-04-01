import { RUNTIME_CONTRACT_VERSION, createRuntimeEvent } from '../runtime-contracts/index.js';

const TOOL_ERROR_CODE = Object.freeze({
  TOOL_NOT_FOUND: 'TOOL_FABRIC_TOOL_NOT_FOUND',
  TOOL_EXECUTION_FAILED: 'TOOL_FABRIC_EXECUTION_FAILED',
  TOOL_TIMEOUT: 'TOOL_FABRIC_TIMEOUT',
  TOOL_CANCELLED: 'TOOL_FABRIC_CANCELLED',
  PERMISSION_DENIED: 'TOOL_FABRIC_PERMISSION_DENIED',
  APPROVAL_DENIED: 'TOOL_FABRIC_APPROVAL_DENIED',
});

const cloneValue = (value) => JSON.parse(JSON.stringify(value));

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

const normalizeNow = (now) => {
  if (typeof now !== 'function') {
    throw new Error('tool-fabric requires now() to return an ISO timestamp string');
  }

  return () => {
    const value = now();
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('tool-fabric now() must return a non-empty ISO timestamp string');
    }
    return value;
  };
};

const normalizeToolInput = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  return cloneValue(input);
};

const createToolError = ({ code, message, details = {}, source = 'policy', retriable = false }) => ({
  code,
  message,
  details: cloneValue(details),
  source,
  retriable,
});

const toStructuredError = (error, fallbackCode) => {
  if (error && typeof error === 'object') {
    return createToolError({
      code: typeof error.code === 'string' && error.code.trim().length > 0 ? error.code : fallbackCode,
      message: typeof error.message === 'string' && error.message.trim().length > 0 ? error.message : 'Unknown tool error',
      details: {
        name: typeof error.name === 'string' ? error.name : 'Error',
      },
      source: 'provider',
      retriable: false,
    });
  }

  return createToolError({
    code: fallbackCode,
    message: 'Unknown tool error',
    details: { value: String(error) },
    source: 'provider',
    retriable: false,
  });
};

const createDeferred = () => {
  /** @type {(value: unknown) => void} */
  let resolve;

  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });

  return {
    promise,
    resolve,
  };
};

const createTimeoutPromise = (timeoutMs) => {
  /** @type {(reason?: string) => void} */
  let cancel;

  const promise = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`Tool execution exceeded timeout of ${timeoutMs}ms`);
      error.code = TOOL_ERROR_CODE.TOOL_TIMEOUT;
      reject(error);
    }, timeoutMs);

    cancel = () => {
      clearTimeout(timer);
    };
  });

  return {
    promise,
    cancel,
  };
};

export const createToolRegistry = ({ tools = [] } = {}) => {
  if (!Array.isArray(tools)) {
    throw new Error('createToolRegistry requires tools as an array');
  }

  const toolMap = new Map();

  const registerTool = (tool) => {
    if (!tool || typeof tool !== 'object') {
      throw new Error('registerTool requires a tool object');
    }

    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (name.length === 0) {
      throw new Error('registerTool requires a non-empty tool name');
    }

    if (typeof tool.execute !== 'function') {
      throw new Error(`registerTool requires execute() for tool ${name}`);
    }

    if (toolMap.has(name)) {
      throw new Error(`registerTool duplicate tool name: ${name}`);
    }

    const normalized = {
      name,
      permissionScope: typeof tool.permissionScope === 'string' ? tool.permissionScope : 'tool:default',
      timeoutPolicy:
        tool.timeoutPolicy && typeof tool.timeoutPolicy === 'object' && !Array.isArray(tool.timeoutPolicy)
          ? {
              timeoutMs: Number.isInteger(tool.timeoutPolicy.timeoutMs) ? tool.timeoutPolicy.timeoutMs : 10_000,
            }
          : { timeoutMs: 10_000 },
      resultSchema:
        tool.resultSchema && typeof tool.resultSchema === 'object' && !Array.isArray(tool.resultSchema)
          ? cloneValue(tool.resultSchema)
          : {},
      requiresApproval: tool.requiresApproval === true,
      execute: tool.execute,
    };

    toolMap.set(name, normalized);
    return cloneValue({ ...normalized, execute: undefined });
  };

  for (const tool of tools) {
    registerTool(tool);
  }

  const getTool = (name) => {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return null;
    }

    const tool = toolMap.get(name.trim());
    return tool ?? null;
  };

  const listTools = () => {
    const output = [];
    for (const tool of toolMap.values()) {
      output.push({
        name: tool.name,
        permissionScope: tool.permissionScope,
        timeoutPolicy: cloneValue(tool.timeoutPolicy),
        resultSchema: cloneValue(tool.resultSchema),
        requiresApproval: tool.requiresApproval,
      });
    }
    return output;
  };

  return {
    registerTool,
    getTool,
    listTools,
  };
};

export const createApprovalBridge = ({ now = () => new Date().toISOString(), createApprovalID } = {}) => {
  const nowIso = normalizeNow(now);
  const approvalSequence = createSequence('approval');
  const pending = new Map();

  const nextApprovalID = () =>
    typeof createApprovalID === 'function' ? createApprovalID({ counter: approvalSequence.peek() + 1 }) : approvalSequence.next();

  const finalize = (approvalID, status, details = {}) => {
    const entry = pending.get(approvalID);
    if (!entry || entry.terminal) {
      return {
        ok: false,
        status: 'noop',
        approvalID,
      };
    }

    entry.terminal = true;
    pending.delete(approvalID);

    const decision = {
      approvalID,
      status,
      decidedAt: nowIso(),
      details: cloneValue(details),
    };

    entry.deferred.resolve(decision);
    return {
      ok: true,
      status,
      approvalID,
    };
  };

  const requestApproval = ({ taskID, invocationID, toolName, input = {} }) => {
    if (typeof taskID !== 'string' || taskID.trim().length === 0) {
      throw new Error('requestApproval requires a non-empty taskID');
    }

    if (typeof invocationID !== 'string' || invocationID.trim().length === 0) {
      throw new Error('requestApproval requires a non-empty invocationID');
    }

    const approvalID = nextApprovalID();
    const deferred = createDeferred();
    const requestedAt = nowIso();

    pending.set(approvalID, {
      terminal: false,
      deferred,
      request: {
        approvalID,
        taskID,
        invocationID,
        toolName,
        input: normalizeToolInput(input),
        requestedAt,
      },
    });

    return {
      approvalID,
      decision: deferred.promise,
      request: cloneValue(pending.get(approvalID).request),
    };
  };

  const approve = (approvalID, details = {}) => finalize(approvalID, 'approved', details);
  const deny = (approvalID, details = {}) => finalize(approvalID, 'denied', details);
  const cancel = (approvalID, reason = 'cancelled') => finalize(approvalID, 'cancelled', { reason });

  const listPending = () => {
    const output = [];
    for (const entry of pending.values()) {
      output.push(cloneValue(entry.request));
    }
    return output;
  };

  return {
    requestApproval,
    approve,
    deny,
    cancel,
    listPending,
  };
};

export const createToolDispatcher = ({
  registry,
  approvalBridge = createApprovalBridge(),
  now = () => new Date().toISOString(),
  runtimeID = 'runtime-host',
  emitEvent = () => {},
  hasPermission = () => true,
  createInvocationID,
} = {}) => {
  if (!registry || typeof registry.getTool !== 'function') {
    throw new Error('createToolDispatcher requires a tool registry');
  }

  if (!approvalBridge || typeof approvalBridge.requestApproval !== 'function') {
    throw new Error('createToolDispatcher requires an approval bridge');
  }

  if (typeof emitEvent !== 'function') {
    throw new Error('createToolDispatcher requires emitEvent callback');
  }

  if (typeof hasPermission !== 'function') {
    throw new Error('createToolDispatcher requires hasPermission callback');
  }

  const nowIso = normalizeNow(now);
  const invocationSequence = createSequence('invocation');
  const eventSequence = createSequence('tool-event');

  const nextInvocationID = () =>
    typeof createInvocationID === 'function'
      ? createInvocationID({ counter: invocationSequence.peek() + 1 })
      : invocationSequence.next();

  const makeEvent = ({ type, taskID, payload = {} }) => {
    const nextSequence = eventSequence.peek() + 1;
    const event = createRuntimeEvent({
      type,
      runtimeID,
      taskID,
      occurredAt: nowIso(),
      payload: {
        eventID: eventSequence.next(),
        eventSequence: nextSequence,
        ...cloneValue(payload),
      },
    });

    emitEvent(event);
    return event;
  };

  const invokeTool = ({ taskID, toolName, input = {}, requiresApproval } = {}) => {
    if (typeof taskID !== 'string' || taskID.trim().length === 0) {
      throw new Error('invokeTool requires a non-empty taskID');
    }

    if (typeof toolName !== 'string' || toolName.trim().length === 0) {
      throw new Error('invokeTool requires a non-empty toolName');
    }

    const normalizedInput = normalizeToolInput(input);
    const tool = registry.getTool(toolName);
    const invocationID = nextInvocationID();
    const invocation = {
      schemaVersion: RUNTIME_CONTRACT_VERSION,
      invocationID,
      taskID,
      toolName,
      input: normalizedInput,
      status: 'queued',
      createdAt: nowIso(),
    };

    const resultDeferred = createDeferred();
    const state = {
      phase: 'queued',
      terminal: false,
      approvalID: null,
      timeoutCanceler: null,
      abortController: new AbortController(),
    };

    const finish = (result, eventType) => {
      if (state.terminal) {
        return result;
      }

      state.terminal = true;
      if (typeof state.timeoutCanceler === 'function') {
        state.timeoutCanceler();
        state.timeoutCanceler = null;
      }

      if (state.approvalID) {
        approvalBridge.cancel(state.approvalID, 'cleanup');
        state.approvalID = null;
      }

      if (eventType) {
        makeEvent({
          type: eventType,
          taskID,
          payload: {
            invocationID,
            toolName,
            status: result.status,
            output: result.output ?? null,
            error: result.error ?? null,
          },
        });
      }

      resultDeferred.resolve(result);
      return result;
    };

    const failWithError = (error, code = TOOL_ERROR_CODE.TOOL_EXECUTION_FAILED, source = 'provider') => {
      const structuredError =
        error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string'
          ? createToolError({
              code: error.code,
              message: error.message,
              details: error.details ?? {},
              source,
              retriable: false,
            })
          : toStructuredError(error, code);

      invocation.status = 'failed';
      return finish(
        {
          ok: false,
          status: 'failed',
          invocation: cloneValue(invocation),
          output: null,
          error: structuredError,
        },
        'tool.failed',
      );
    };

    const cancel = (reason = 'cancelled') => {
      if (state.terminal) {
        return false;
      }

      if (state.approvalID) {
        approvalBridge.cancel(state.approvalID, reason);
      }

      state.abortController.abort();

      finish(
        {
          ok: false,
          status: 'cancelled',
          invocation: cloneValue(invocation),
          output: null,
          error: createToolError({
            code: TOOL_ERROR_CODE.TOOL_CANCELLED,
            message: `Tool invocation cancelled: ${reason}`,
            details: { reason },
            source: 'policy',
            retriable: false,
          }),
        },
        'tool.cancelled',
      );

      return true;
    };

    makeEvent({
      type: 'tool.queued',
      taskID,
      payload: {
        invocationID,
        toolName,
        status: 'queued',
      },
    });

    if (!tool) {
      failWithError(
        createToolError({
          code: TOOL_ERROR_CODE.TOOL_NOT_FOUND,
          message: `Tool not found: ${toolName}`,
          details: { toolName },
          source: 'policy',
          retriable: false,
        }),
        TOOL_ERROR_CODE.TOOL_NOT_FOUND,
        'policy',
      );

      return {
        invocationID,
        invocation: cloneValue(invocation),
        result: resultDeferred.promise,
        cancel,
      };
    }

    const execute = async () => {
      const permissionAllowed = hasPermission({
        taskID,
        invocationID,
        toolName,
        permissionScope: tool.permissionScope,
        input: normalizedInput,
      });

      if (!permissionAllowed) {
        failWithError(
          createToolError({
            code: TOOL_ERROR_CODE.PERMISSION_DENIED,
            message: `Permission denied for scope ${tool.permissionScope}`,
            details: {
              permissionScope: tool.permissionScope,
            },
            source: 'policy',
            retriable: false,
          }),
          TOOL_ERROR_CODE.PERMISSION_DENIED,
          'policy',
        );
        return;
      }

      const approvalRequired = typeof requiresApproval === 'boolean' ? requiresApproval : tool.requiresApproval;

      if (approvalRequired) {
        const approvalRequest = approvalBridge.requestApproval({
          taskID,
          invocationID,
          toolName,
          input: normalizedInput,
        });

        state.approvalID = approvalRequest.approvalID;

        makeEvent({
          type: 'approval.requested',
          taskID,
          payload: {
            invocationID,
            toolName,
            approvalID: approvalRequest.approvalID,
          },
        });

        const decision = await approvalRequest.decision;
        state.approvalID = null;

        if (state.terminal) {
          return;
        }

        if (decision.status === 'denied') {
          makeEvent({
            type: 'approval.denied',
            taskID,
            payload: {
              invocationID,
              toolName,
              approvalID: decision.approvalID,
            },
          });

          failWithError(
            createToolError({
              code: TOOL_ERROR_CODE.APPROVAL_DENIED,
              message: `Approval denied for tool ${toolName}`,
              details: {
                approvalID: decision.approvalID,
              },
              source: 'policy',
              retriable: false,
            }),
            TOOL_ERROR_CODE.APPROVAL_DENIED,
            'policy',
          );
          return;
        }

        if (decision.status !== 'approved') {
          return;
        }

        makeEvent({
          type: 'approval.granted',
          taskID,
          payload: {
            invocationID,
            toolName,
            approvalID: decision.approvalID,
          },
        });
      }

      if (state.terminal) {
        return;
      }

      invocation.status = 'running';
      state.phase = 'running';

      makeEvent({
        type: 'tool.running',
        taskID,
        payload: {
          invocationID,
          toolName,
          status: 'running',
        },
      });

      const timeoutMs = tool.timeoutPolicy.timeoutMs;
      const timeoutPromise = createTimeoutPromise(timeoutMs);
      state.timeoutCanceler = timeoutPromise.cancel;

      try {
        const output = await Promise.race([
          Promise.resolve(
            tool.execute({
              taskID,
              invocationID,
              toolName,
              input: normalizedInput,
              signal: state.abortController.signal,
            }),
          ),
          timeoutPromise.promise,
        ]);

        if (state.terminal) {
          return;
        }

        invocation.status = 'completed';
        finish(
          {
            ok: true,
            status: 'completed',
            invocation: cloneValue(invocation),
            output: cloneValue(output),
            error: null,
          },
          'tool.completed',
        );
      } catch (error) {
        if (state.terminal) {
          return;
        }

        if (error && typeof error === 'object' && error.code === TOOL_ERROR_CODE.TOOL_TIMEOUT) {
          failWithError(error, TOOL_ERROR_CODE.TOOL_TIMEOUT, 'policy');
          return;
        }

        failWithError(error, TOOL_ERROR_CODE.TOOL_EXECUTION_FAILED, 'provider');
      }
    };

    execute();

    return {
      invocationID,
      invocation: cloneValue(invocation),
      result: resultDeferred.promise,
      cancel,
    };
  };

  return {
    invokeTool,
  };
};

export { TOOL_ERROR_CODE };
