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
    name: 'Explore',
    description: 'OMO codebase search specialist agent.',
    mode: 'subagent',
    prompt: '',
    permission: [],
    options: {},
    native: true,
  },
  {
    name: 'Hephaestus',
    description: 'OMO autonomous deep-work execution agent.',
    mode: 'primary',
    prompt: '',
    permission: [],
    options: {},
    native: true,
  },
  {
    name: 'Librarian',
    description: 'OMO external code and documentation research agent.',
    mode: 'subagent',
    prompt: '',
    permission: [],
    options: {},
    native: true,
  },
  {
    name: 'Metis',
    description: 'OMO pre-planning consultant agent.',
    mode: 'subagent',
    prompt: '',
    permission: [],
    options: {},
    native: true,
  },
  {
    name: 'Momus',
    description: 'OMO work-plan review agent.',
    mode: 'subagent',
    prompt: '',
    permission: [],
    options: {},
    native: true,
  },
  {
    name: 'Multimodal-Looker',
    description: 'OMO media interpretation and extraction agent.',
    mode: 'subagent',
    prompt: '',
    permission: [],
    options: {},
    native: true,
  },
  {
    name: 'Oracle',
    description: 'OMO strategic consultation and review agent.',
    mode: 'subagent',
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

export const mergeOmoAgents = (agents: readonly Agent[], options: { injectMissing?: boolean } = {}): AgentWithExtras[] => {
  const injectMissing = options.injectMissing !== false;
  const byName = new Map<string, AgentWithExtras>();

  for (const agent of agents) {
    byName.set(agent.name, agent as AgentWithExtras);
  }

  for (const omoAgent of OMO_UI_AGENTS) {
    const existing = byName.get(omoAgent.name);
    if (existing) {
      byName.set(omoAgent.name, {
        ...existing,
        description: existing.description || omoAgent.description,
        native: existing.native ?? omoAgent.native,
        group: existing.group ?? omoAgent.group,
      });
      continue;
    }

    if (injectMissing) {
      byName.set(omoAgent.name, { ...omoAgent });
    }
  }

  return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name));
};

export const isPrimaryAgentMode = (mode?: string): boolean =>
  mode === 'primary' || mode === 'all' || mode === undefined || mode === null;

export const isSelectableMainAgent = (agent: Agent | undefined | null): agent is Agent => {
  if (!agent) {
    return false;
  }

  return !isAgentHidden(agent) && isPrimaryAgentMode(agent.mode);
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
