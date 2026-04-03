export interface AuthMethod {
  type?: string;
  name?: string;
  label?: string;
  description?: string;
  help?: string;
  method?: number;
  [key: string]: unknown;
}

export interface ProviderOption {
  id: string;
  name?: string;
  connected?: boolean;
  runtimeManaged?: boolean;
  connectMode?: 'api' | 'config';
  supportsBaseUrl?: boolean;
}

export interface ProviderSourceInfo {
  exists: boolean;
  path?: string | null;
}

export interface ProviderSources {
  auth: ProviderSourceInfo;
  user: ProviderSourceInfo;
  project: ProviderSourceInfo;
  custom?: ProviderSourceInfo;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const normalizeAuthType = (method: AuthMethod) => {
  const raw = typeof method.type === 'string' ? method.type : '';
  const label = `${method.name ?? ''} ${method.label ?? ''}`.toLowerCase();
  const merged = `${raw} ${label}`.toLowerCase();
  if (merged.includes('oauth')) return 'oauth';
  if (merged.includes('api')) return 'api';
  return raw.toLowerCase();
};

export const parseAuthPayload = (payload: unknown): Record<string, AuthMethod[]> => {
  if (!isRecord(payload)) {
    return {};
  }
  const result: Record<string, AuthMethod[]> = {};
  for (const [providerId, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      result[providerId] = value.filter((entry) => isRecord(entry)) as AuthMethod[];
    }
  }
  return result;
};

export const normalizeProviderEntry = (entry: unknown): ProviderOption | null => {
  if (typeof entry === 'string') {
    return { id: entry };
  }
  if (!isRecord(entry)) {
    return null;
  }

  const idCandidate =
    (typeof entry.id === 'string' && entry.id) ||
    (typeof entry.providerID === 'string' && entry.providerID) ||
    (typeof entry.providerId === 'string' && entry.providerId) ||
    (typeof entry.slug === 'string' && entry.slug);

  if (!idCandidate) {
    return null;
  }

  const nameCandidate = typeof entry.name === 'string' ? entry.name : undefined;
  const connected = typeof entry.connected === 'boolean' ? entry.connected : undefined;
  const runtimeManaged = entry.runtimeManaged === true;
  const connectMode = entry.connectMode === 'config' ? 'config' : entry.connectMode === 'api' ? 'api' : undefined;
  const supportsBaseUrl = entry.supportsBaseUrl === true;

  return {
    id: idCandidate,
    name: nameCandidate,
    connected,
    runtimeManaged,
    connectMode,
    supportsBaseUrl,
  };
};

export const parseProvidersPayload = (payload: unknown): ProviderOption[] => {
  let entries: unknown[] = [];

  if (Array.isArray(payload)) {
    entries = payload;
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.all)) {
      entries = payload.all;
    } else if (Array.isArray(payload.providers)) {
      entries = payload.providers;
    }
  }

  const mapped = entries
    .map((entry) => normalizeProviderEntry(entry))
    .filter((entry): entry is ProviderOption => Boolean(entry));

  const seen = new Set<string>();
  return mapped.filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
};
