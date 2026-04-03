import type { Agent } from '@opencode-ai/sdk/v2';

export type AgentWithExtras = Agent & {
  native?: boolean;
  hidden?: boolean;
  options?: { hidden?: boolean };
  scope?: 'user' | 'project';
  group?: string;
};

export const OMO_UI_AGENTS: readonly AgentWithExtras[] = Object.freeze([
  {
    name: 'Atlas',
    description: 'OMO planning and orchestration agent.',
    mode: 'primary',
    prompt: '',
    permission: [],
    options: {},
    native: true,
  },
  {
    name: 'Prometheus',
    description: 'OMO execution planning agent for multi-step implementation.',
    mode: 'subagent',
    prompt: '',
    permission: [],
    options: {},
    native: true,
  },
  {
    name: 'Sisyphus',
    description: 'OMO ultrawork execution agent.',
    mode: 'primary',
    prompt: '',
    permission: [],
    options: {},
    native: true,
  },
  {
    name: 'Sisyphus-Junior',
    description: 'OMO delegated subagent executor.',
    mode: 'subagent',
    prompt: '',
    permission: [],
    options: {},
    native: true,
  },
]);

export const mergeOmoAgents = (agents: readonly Agent[]): AgentWithExtras[] => {
  const byName = new Map<string, AgentWithExtras>();

  for (const agent of agents) {
    byName.set(agent.name, agent as AgentWithExtras);
  }

  for (const agent of OMO_UI_AGENTS) {
    if (!byName.has(agent.name)) {
      byName.set(agent.name, { ...agent });
    }
  }

  return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name));
};

export const isAgentBuiltIn = (agent: Agent): boolean => {
  const extended = agent as AgentWithExtras & { builtIn?: boolean };
  return extended.native === true || extended.builtIn === true;
};

export const isAgentHidden = (agent: Agent): boolean => {
  const extended = agent as AgentWithExtras;
  return extended.hidden === true || extended.options?.hidden === true;
};

export const filterVisibleAgents = (agents: Agent[]): Agent[] =>
  agents.filter((agent) => !isAgentHidden(agent));
