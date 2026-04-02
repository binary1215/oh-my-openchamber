import React from 'react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui';
import {
  opencodeClient,
  type RuntimeProviderNegotiation,
  type RuntimeSseEvent,
  type RuntimeTask,
} from '@/lib/opencode/client';
import { useConfigStore } from '@/stores/useConfigStore';
import { cn } from '@/lib/utils';

type CapabilityKey = 'tools' | 'structured-output' | 'streaming';

const REQUIRED_CAPABILITIES: Array<'chat' | CapabilityKey> = ['chat', 'tools', 'structured-output', 'streaming'];

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unexpected error';
};

const formatCapabilityLabel = (capability: CapabilityKey) => {
  if (capability === 'structured-output') return 'Structured output';
  if (capability === 'streaming') return 'Streaming';
  return 'Tools';
};

const getLatestTaskStatusFromEvent = (eventType: string) => {
  if (eventType === 'task.enqueued') return 'queued';
  if (eventType === 'task.started') return 'running';
  if (eventType === 'task.completed') return 'completed';
  if (eventType === 'task.failed') return 'failed';
  if (eventType === 'task.cancelled') return 'cancelled';
  return null;
};

export const RuntimeControlsPanel: React.FC = () => {
  const selectedProviderId = useConfigStore((state) => state.selectedProviderId);
  const runtimeControlsEnabled = useConfigStore((state) => state.runtimeControlsEnabled);
  const runtimeRequireTools = useConfigStore((state) => state.runtimeRequireTools);
  const runtimeRequireStructuredOutput = useConfigStore((state) => state.runtimeRequireStructuredOutput);
  const runtimeRequireStreaming = useConfigStore((state) => state.runtimeRequireStreaming);
  const setRuntimeControlsEnabled = useConfigStore((state) => state.setRuntimeControlsEnabled);
  const setRuntimeRequireTools = useConfigStore((state) => state.setRuntimeRequireTools);
  const setRuntimeRequireStructuredOutput = useConfigStore((state) => state.setRuntimeRequireStructuredOutput);
  const setRuntimeRequireStreaming = useConfigStore((state) => state.setRuntimeRequireStreaming);

  const [runtimeAvailable, setRuntimeAvailable] = React.useState<boolean | null>(null);
  const [runtimeSessionId, setRuntimeSessionId] = React.useState<string | null>(null);
  const [runtimeBusy, setRuntimeBusy] = React.useState(false);
  const [runtimeError, setRuntimeError] = React.useState<string | null>(null);

  const [negotiation, setNegotiation] = React.useState<RuntimeProviderNegotiation | null>(null);
  const [negotiationError, setNegotiationError] = React.useState<string | null>(null);
  const [events, setEvents] = React.useState<RuntimeSseEvent[]>([]);
  const [latestTask, setLatestTask] = React.useState<RuntimeTask | null>(null);

  const degradableCapabilities = React.useMemo(() => {
    const degradable: CapabilityKey[] = [];
    if (!runtimeRequireTools) degradable.push('tools');
    if (!runtimeRequireStructuredOutput) degradable.push('structured-output');
    if (!runtimeRequireStreaming) degradable.push('streaming');
    return degradable;
  }, [runtimeRequireTools, runtimeRequireStructuredOutput, runtimeRequireStreaming]);

  React.useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!runtimeControlsEnabled) {
        setRuntimeAvailable(null);
        setRuntimeSessionId(null);
        setRuntimeError(null);
        return;
      }

      try {
        setRuntimeError(null);
        const response = await opencodeClient.createRuntimeSession({
          metadata: { source: 'openchamber-ui', providerID: selectedProviderId || null },
        });
        if (cancelled) return;
        setRuntimeAvailable(true);
        setRuntimeSessionId(response.session.sessionID);
      } catch (error) {
        if (cancelled) return;
        setRuntimeAvailable(false);
        setRuntimeSessionId(null);
        setRuntimeError(getErrorMessage(error));
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [runtimeControlsEnabled, selectedProviderId]);

  React.useEffect(() => {
    if (!runtimeControlsEnabled) {
      return;
    }

    const controller = new AbortController();
    const close = opencodeClient.subscribeRuntimeEvents({
      signal: controller.signal,
      onEvent: (event) => {
        setEvents((prev) => {
          const next = prev.length >= 25 ? prev.slice(prev.length - 24) : prev;
          return [...next, event];
        });

        const taskId = event.properties.taskID;
        if (taskId) {
          const nextStatus = getLatestTaskStatusFromEvent(event.type);
          if (nextStatus) {
            setLatestTask((prev) => {
              if (prev?.taskID !== taskId) {
                return {
                  taskID: taskId,
                  runtimeID: event.properties.runtimeID,
                  status: nextStatus,
                  createdAt: event.properties.occurredAt,
                  updatedAt: event.properties.occurredAt,
                  startedAt: null,
                  finishedAt: null,
                  metadata: {},
                };
              }

              if (prev.status === nextStatus) {
                return prev;
              }

              return {
                ...prev,
                status: nextStatus,
                updatedAt: event.properties.occurredAt,
              };
            });
          }
        }
      },
      onError: (error) => {
        setRuntimeError(getErrorMessage(error));
      },
    });

    return () => {
      controller.abort();
      close();
    };
  }, [runtimeControlsEnabled]);

  React.useEffect(() => {
    let cancelled = false;

    const runNegotiation = async () => {
      if (!runtimeControlsEnabled) {
        setNegotiation(null);
        setNegotiationError(null);
        return;
      }

      if (!selectedProviderId) {
        setNegotiation(null);
        setNegotiationError(null);
        return;
      }

      try {
        setNegotiationError(null);
        const response = await opencodeClient.negotiateRuntimeProvider({
          providerID: selectedProviderId,
          requiredCapabilities: REQUIRED_CAPABILITIES,
          degradableCapabilities,
        });
        if (cancelled) return;
        setNegotiation(response);
      } catch (error) {
        if (cancelled) return;
        setNegotiation(null);
        setNegotiationError(getErrorMessage(error));
      }
    };

    void runNegotiation();

    return () => {
      cancelled = true;
    };
  }, [runtimeControlsEnabled, selectedProviderId, degradableCapabilities]);

  React.useEffect(() => {
    if (!latestTask) {
      setRuntimeBusy(false);
      return;
    }

    setRuntimeBusy(latestTask.status === 'running' || latestTask.status === 'queued');
  }, [latestTask]);

  const latestEvent = events.length > 0 ? events[events.length - 1] : null;

  const capabilityStatus = React.useMemo(() => {
    const missing = new Set(negotiation?.missingCapabilities ?? []);
    const degraded = new Set(negotiation?.degradedCapabilities ?? []);

    const getState = (capability: CapabilityKey) => {
      if (missing.has(capability)) {
        return degraded.has(capability) ? 'degraded' : 'missing';
      }
      return 'supported';
    };

    return {
      tools: getState('tools'),
      'structured-output': getState('structured-output'),
      streaming: getState('streaming'),
    };
  }, [negotiation]);

  const canRun =
    runtimeControlsEnabled &&
    Boolean(selectedProviderId) &&
    Boolean(negotiation) &&
    negotiation?.outcome !== 'refuse';

  const handleRunTask = async () => {
    if (!selectedProviderId) {
      toast.error('Select a provider first');
      return;
    }

    setRuntimeError(null);
    try {
      const response = await opencodeClient.runRuntimeTask({
        metadata: {
          source: 'openchamber-ui',
          scenario: 'runtime-control',
        },
        providerID: selectedProviderId,
        requiredCapabilities: REQUIRED_CAPABILITIES,
        degradableCapabilities,
        toolInvocation: {
          toolName: 'runtime.echo',
          input: { hello: 'runtime' },
          requiresApproval: true,
          autoApprove: true,
        },
      });

      setLatestTask(response.task);
      if (response.negotiation) {
        setNegotiation(response.negotiation);
      }
    } catch (error) {
      setRuntimeError(getErrorMessage(error));
    }
  };

  const handleCancelTask = async () => {
    const taskId = latestTask?.taskID;
    if (!taskId) {
      toast.error('No active task');
      return;
    }

    setRuntimeError(null);
    try {
      const response = await opencodeClient.cancelRuntimeTask({ taskID: taskId, reason: 'ui-cancel' });
      setLatestTask(response.task);
    } catch (error) {
      setRuntimeError(getErrorMessage(error));
    }
  };

  return (
    <div className="mb-8" data-testid="runtime-controls">
      <div className="mb-1 px-1 flex items-center justify-between gap-2">
        <h3 className="typography-ui-header font-medium text-foreground">Runtime</h3>
        <div className="flex items-center gap-2">
          <span className="typography-micro text-muted-foreground">Enabled</span>
          <Switch
            checked={runtimeControlsEnabled}
            onCheckedChange={(value) => setRuntimeControlsEnabled(value)}
            aria-label="Enable runtime controls"
          />
        </div>
      </div>

      <section className="px-2 pb-2 pt-0">
        {!runtimeControlsEnabled ? (
          <p className="typography-meta text-muted-foreground py-2">Enable runtime controls to monitor and run tasks.</p>
        ) : (
          <div className="space-y-3 py-1.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col">
                <span className="typography-meta text-foreground">
                  Status:{' '}
                  <span
                    className={cn(
                      'font-medium',
                      runtimeAvailable === false && 'text-[var(--status-error)]',
                      runtimeAvailable === true && (runtimeBusy ? 'text-[var(--status-warning)]' : 'text-[var(--status-success)]')
                    )}
                  >
                    {runtimeAvailable === null
                      ? 'Checking...'
                      : runtimeAvailable
                        ? runtimeBusy
                          ? 'Busy'
                          : 'Idle'
                        : 'Unavailable'}
                  </span>
                </span>
                <span className="typography-micro text-muted-foreground">
                  Session: {runtimeSessionId ? runtimeSessionId : '—'}
                </span>
                {latestTask && (
                  <span className="typography-micro text-muted-foreground">
                    Latest task: <span className="font-mono">{latestTask.taskID}</span> ({latestTask.status})
                  </span>
                )}
                {latestEvent && (
                  <span className="typography-micro text-muted-foreground">
                    Latest event: <span className="font-mono">{latestEvent.type}</span>
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  size="xs"
                  className="!font-normal"
                  onClick={handleRunTask}
                  disabled={!canRun}
                >
                  Run task
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  className="!font-normal"
                  onClick={handleCancelTask}
                  disabled={!latestTask || (latestTask.status !== 'running' && latestTask.status !== 'queued')}
                >
                  Cancel
                </Button>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="flex items-center justify-between rounded-lg border bg-[var(--surface-elevated)] px-3 py-2">
                <div className="flex flex-col">
                  <span className="typography-meta text-foreground">Tools</span>
                  <span className="typography-micro text-muted-foreground">Require provider tool support</span>
                </div>
                <Switch
                  checked={runtimeRequireTools}
                  onCheckedChange={(value) => setRuntimeRequireTools(value)}
                  aria-label="Require tools capability"
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border bg-[var(--surface-elevated)] px-3 py-2">
                <div className="flex flex-col">
                  <span className="typography-meta text-foreground">Structured output</span>
                  <span className="typography-micro text-muted-foreground">Require structured output support</span>
                </div>
                <Switch
                  checked={runtimeRequireStructuredOutput}
                  onCheckedChange={(value) => setRuntimeRequireStructuredOutput(value)}
                  aria-label="Require structured output capability"
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border bg-[var(--surface-elevated)] px-3 py-2">
                <div className="flex flex-col">
                  <span className="typography-meta text-foreground">Streaming</span>
                  <span className="typography-micro text-muted-foreground">Require streaming responses</span>
                </div>
                <Switch
                  checked={runtimeRequireStreaming}
                  onCheckedChange={(value) => setRuntimeRequireStreaming(value)}
                  aria-label="Require streaming capability"
                />
              </div>

              <div className="rounded-lg border bg-[var(--surface-elevated)] px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="typography-meta text-foreground">Provider capabilities</span>
                  <span className="typography-micro text-muted-foreground">
                    {negotiation ? negotiation.outcome : negotiationError ? 'Error' : 'Checking...'}
                  </span>
                </div>
                <div className="mt-2 space-y-1">
                  {(['tools', 'structured-output', 'streaming'] as CapabilityKey[]).map((capability) => {
                    const state = capabilityStatus[capability];
                    const label = formatCapabilityLabel(capability);
                    const statusText = state === 'supported' ? 'Supported' : state === 'degraded' ? 'Missing (allowed)' : 'Missing';
                    const statusClass =
                      state === 'supported'
                        ? 'text-[var(--status-success)]'
                        : state === 'degraded'
                          ? 'text-[var(--status-warning)]'
                          : 'text-[var(--status-error)]';

                    return (
                      <div key={capability} className="flex items-center justify-between">
                        <span className="typography-micro text-muted-foreground">{label}</span>
                        <span className={cn('typography-micro font-medium', statusClass)}>{statusText}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {negotiation?.outcome === 'refuse' && (
              <div className="rounded-lg border border-[var(--status-error)]/30 bg-[var(--status-error)]/5 px-3 py-2">
                <p className="typography-meta text-[var(--status-error)]">
                  Provider cannot satisfy required capabilities.
                  {negotiation?.reason ? ` ${negotiation.reason}` : ''}
                </p>
              </div>
            )}

            {negotiation?.outcome === 'degrade' && (
              <div className="rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 px-3 py-2">
                <p className="typography-meta text-[var(--status-warning)]">
                  Provider is missing some capabilities; runtime will run in degraded mode.
                </p>
              </div>
            )}

            {(runtimeError || negotiationError) && (
              <div className="rounded-lg border border-[var(--status-error)]/30 bg-[var(--status-error)]/5 px-3 py-2">
                <p className="typography-meta text-[var(--status-error)]">{runtimeError || negotiationError}</p>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
