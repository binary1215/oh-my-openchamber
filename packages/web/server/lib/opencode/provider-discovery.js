import {
  createLiteLlmAdapter,
  createOllamaAdapter,
  PROVIDER_ADAPTER_ERROR_CODE,
} from '../provider-adapters/index.js';

const DISCOVERY_TIMEOUT_MS = 8_000;

const discoveryCache = new Map();

const RUNTIME_MANAGED_ADAPTER_FACTORIES = Object.freeze({
  litellm: () => createLiteLlmAdapter(),
  ollama: () => createOllamaAdapter(),
});

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeModelIdentifier = (value) => {
  const normalized = normalizeString(value);
  return normalized.length > 0 ? normalized : null;
};

const buildDiscoveryCacheKey = (providerId, directory) => `${providerId}::${normalizeString(directory) || '__global__'}`;

const buildDiscoverySignature = ({ auth, sources }) => {
  const apiKey =
    normalizeString(auth?.apiKey) ||
    normalizeString(auth?.key) ||
    normalizeString(auth?.token) ||
    '';
  const baseURL =
    normalizeString(auth?.baseURL) ||
    normalizeString(auth?.baseUrl) ||
    normalizeString(auth?.url) ||
    '';

  return JSON.stringify({
    apiKey,
    baseURL,
    user: Boolean(sources?.user?.exists),
    project: Boolean(sources?.project?.exists),
    custom: Boolean(sources?.custom?.exists),
  });
};

const createEmptyProviderModels = () => Object.create(null);

const createDefaultCapabilities = ({ attachment = false } = {}) => ({
  temperature: true,
  reasoning: false,
  attachment,
  toolcall: true,
  input: {
    text: true,
    audio: false,
    image: attachment,
    video: false,
    pdf: false,
  },
  output: {
    text: true,
    audio: false,
    image: false,
    video: false,
    pdf: false,
  },
  interleaved: false,
});

const createDefaultCost = () => ({
  input: 0,
  output: 0,
  cache: {
    read: 0,
    write: 0,
  },
});

const createDefaultLimit = () => ({
  context: 0,
  output: 0,
});

const createDefaultApiMetadata = (providerId, modelId) => {
  if (providerId === 'ollama') {
    return {
      id: modelId,
      npm: '@ai-sdk/ollama',
    };
  }

  return {
    id: modelId,
    npm: '@ai-sdk/openai-compatible',
  };
};

const normalizeDiscoveredModel = ({ providerId, candidate, modelId, modelName }) => ({
  ...candidate,
  id: modelId,
  providerID: typeof candidate.providerID === 'string' && candidate.providerID ? candidate.providerID : providerId,
  name: modelName,
  family: typeof candidate.family === 'string' && candidate.family ? candidate.family : 'external',
  api: candidate.api && typeof candidate.api === 'object' ? candidate.api : createDefaultApiMetadata(providerId, modelId),
  status: typeof candidate.status === 'string' && candidate.status ? candidate.status : 'active',
  headers: candidate.headers && typeof candidate.headers === 'object' ? candidate.headers : {},
  options: candidate.options && typeof candidate.options === 'object' ? candidate.options : {},
  cost: candidate.cost && typeof candidate.cost === 'object' ? candidate.cost : createDefaultCost(),
  limit: candidate.limit && typeof candidate.limit === 'object' ? candidate.limit : createDefaultLimit(),
  capabilities: candidate.capabilities && typeof candidate.capabilities === 'object'
    ? candidate.capabilities
    : createDefaultCapabilities({ attachment: providerId === 'ollama' }),
  variants: candidate.variants && typeof candidate.variants === 'object' ? candidate.variants : {},
});

const normalizeOpenAiCompatibleModels = (providerId, payload) => {
  const candidates = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];

  const models = createEmptyProviderModels();

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    const modelId =
      normalizeModelIdentifier(candidate.id) ||
      normalizeModelIdentifier(candidate.name) ||
      normalizeModelIdentifier(candidate.model);

    if (!modelId) {
      continue;
    }

    const modelName =
      normalizeModelIdentifier(candidate.name) ||
      normalizeModelIdentifier(candidate.id) ||
      modelId;

    models[modelId] = normalizeDiscoveredModel({
      providerId,
      candidate,
      modelId,
      modelName,
    });
  }

  return models;
};

const normalizeOllamaModels = (providerId, payload) => {
  const candidates = Array.isArray(payload?.models)
    ? payload.models
    : Array.isArray(payload)
      ? payload
      : [];

  const models = createEmptyProviderModels();

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    const modelId =
      normalizeModelIdentifier(candidate.model) ||
      normalizeModelIdentifier(candidate.name) ||
      normalizeModelIdentifier(candidate.id);

    if (!modelId) {
      continue;
    }

    const modelName =
      normalizeModelIdentifier(candidate.name) ||
      normalizeModelIdentifier(candidate.model) ||
      modelId;

    models[modelId] = normalizeDiscoveredModel({
      providerId,
      candidate,
      modelId,
      modelName,
    });
  }

  return models;
};

const normalizeDiscoveredModels = (providerId, payload) => {
  if (providerId === 'ollama') {
    return normalizeOllamaModels(providerId, payload);
  }

  return normalizeOpenAiCompatibleModels(providerId, payload);
};

const classifyErrorResponse = async (response) => {
  const payload = await response.json().catch(() => null);
  const message =
    normalizeString(payload?.error) ||
    normalizeString(payload?.message) ||
    `Model discovery request failed (${response.status})`;

  if (response.status === 401 || response.status === 403) {
    return {
      state: 'error',
      errorType: 'auth',
      message,
      models: createEmptyProviderModels(),
    };
  }

  return {
    state: 'error',
    errorType: 'connection',
    message,
    models: createEmptyProviderModels(),
  };
};

const fetchWithTimeout = async (url, options) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const performRuntimeManagedDiscovery = async ({ providerId }) => {
  const createAdapter = RUNTIME_MANAGED_ADAPTER_FACTORIES[providerId];
  if (!createAdapter) {
    return {
      state: 'error',
      errorType: 'unsupported',
      message: `Unsupported runtime-managed provider: ${providerId}`,
      models: createEmptyProviderModels(),
    };
  }

  try {
    const adapter = createAdapter();
    const request = adapter.buildModelsListRequest();
    const targetUrl = new URL(request.path, request.baseUrl).toString();
    const response = await fetchWithTimeout(targetUrl, {
      method: request.method,
      headers: {
        Accept: 'application/json',
        ...(request.headers ?? {}),
      },
    });

    if (!response.ok) {
      return classifyErrorResponse(response);
    }

    const payload = await response.json().catch(() => null);
    const models = normalizeDiscoveredModels(providerId, payload);

    return {
      state: Object.keys(models).length > 0 ? 'ready' : 'empty',
      errorType: null,
      message: null,
      models,
    };
  } catch (error) {
    if (error?.code === PROVIDER_ADAPTER_ERROR_CODE.AUTH_CONFIGURATION) {
      return {
        state: 'error',
        errorType: 'auth',
        message: error.message || 'Provider authentication is incomplete',
        models: createEmptyProviderModels(),
      };
    }

    const message = error?.name === 'AbortError'
      ? 'Model discovery timed out'
      : error?.message || 'Failed to reach provider endpoint';

    return {
      state: 'error',
      errorType: 'connection',
      message,
      models: createEmptyProviderModels(),
    };
  }
};

const runDiscovery = async (cacheKey, input) => {
  const entry = discoveryCache.get(cacheKey);
  if (!entry) {
    return;
  }

  const result = await performRuntimeManagedDiscovery(input);
  const currentEntry = discoveryCache.get(cacheKey);
  if (!currentEntry || currentEntry.signature !== entry.signature) {
    return;
  }

  discoveryCache.set(cacheKey, {
    ...currentEntry,
    state: result.state,
    errorType: result.errorType,
    message: result.message,
    models: result.models,
    promise: null,
    updatedAt: Date.now(),
  });
};

export const invalidateProviderDiscovery = (providerId) => {
  for (const key of discoveryCache.keys()) {
    if (key.startsWith(`${providerId}::`)) {
      discoveryCache.delete(key);
    }
  }
};

export const resolveRuntimeManagedDiscovery = ({
  providerId,
  directory,
  auth,
  sources,
}) => {
  const cacheKey = buildDiscoveryCacheKey(providerId, directory);
  const signature = buildDiscoverySignature({ auth, sources });
  const existing = discoveryCache.get(cacheKey);

  if (existing && existing.signature === signature) {
    return {
      state: existing.state,
      errorType: existing.errorType,
      message: existing.message,
      models: existing.models,
    };
  }

  const nextEntry = {
    signature,
    state: 'discovering',
    errorType: null,
    message: null,
    models: existing?.models ?? createEmptyProviderModels(),
    promise: null,
    updatedAt: Date.now(),
  };

  discoveryCache.set(cacheKey, nextEntry);
  nextEntry.promise = runDiscovery(cacheKey, {
    providerId,
    directory,
    auth,
    sources,
  });

  return {
    state: nextEntry.state,
    errorType: nextEntry.errorType,
    message: nextEntry.message,
    models: nextEntry.models,
  };
};
