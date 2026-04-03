import { getProviderAuth } from '../opencode/auth.js';
import { resolveOpenCodeEnvConfig } from '../opencode/env-config.js';
import { getProviderSources } from '../opencode/providers.js';
import {
  normalizeCapabilityMatrix,
  parseOllamaNdjsonStream,
  parseOpenAiSseStream,
} from '../provider-conformance/index.js';

export const PROVIDER_ADAPTER_VERSION = 'provider.adapter.v1';
export const PROVIDER_ADAPTER_ERROR_CODE = Object.freeze({
  STREAM_PARSE: 'PROVIDER_ADAPTER_STREAM_PARSE_ERROR',
  TOOL_PAYLOAD_PARSE: 'PROVIDER_ADAPTER_TOOL_PAYLOAD_PARSE_ERROR',
  STRUCTURED_OUTPUT_PARSE: 'PROVIDER_ADAPTER_STRUCTURED_OUTPUT_PARSE_ERROR',
  AUTH_CONFIGURATION: 'PROVIDER_ADAPTER_AUTH_CONFIGURATION_ERROR',
});

const DEFAULT_BASE_URL = Object.freeze({
  openai: 'https://api.openai.com',
  litellm: 'http://127.0.0.1:4000',
  ollama: 'http://127.0.0.1:11434',
});

const normalizeBaseUrl = (value, fallback) => {
  const candidate = typeof value === 'string' ? value.trim() : '';
  const selected = candidate || fallback;

  try {
    return new URL(selected).origin;
  } catch {
    throw new Error(`Invalid provider base URL: ${JSON.stringify(selected)}`);
  }
};

const normalizeApiKey = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const createAdapterParseError = ({ code, providerID, operation, message, cause }) => {
  const error = new Error(message);
  error.name = 'ProviderAdapterParseError';
  error.code = code;
  error.providerID = providerID;
  error.operation = operation;
  error.cause = cause;
  return error;
};

const createProviderContextResolver = ({ providerID, dependencies, options }) => {
  return () => {
    const providerSources = dependencies.getProviderSources(providerID, options.workingDirectory);
    const providerAuth = dependencies.getProviderAuth(providerID);
    const envConfig = dependencies.resolveOpenCodeEnvConfig({ env: options.env, logger: options.logger });

    const apiKey =
      normalizeApiKey(options.apiKey) ||
      normalizeApiKey(providerAuth?.apiKey) ||
      normalizeApiKey(providerAuth?.key) ||
      normalizeApiKey(providerAuth?.token) ||
      null;

    const baseUrlFromAuth =
      normalizeApiKey(providerAuth?.baseURL) ||
      normalizeApiKey(providerAuth?.baseUrl) ||
      normalizeApiKey(providerAuth?.url) ||
      null;

    return {
      providerSources,
      providerAuth,
      envConfig,
      apiKey,
      baseUrlFromAuth,
    };
  };
};

const normalizeToolCallsJsonString = (providerID, toolCalls) => {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.map((toolCall, index) => {
    if (!toolCall || typeof toolCall !== 'object' || !toolCall.function || typeof toolCall.function !== 'object') {
      throw createAdapterParseError({
        code: PROVIDER_ADAPTER_ERROR_CODE.TOOL_PAYLOAD_PARSE,
        providerID,
        operation: 'normalizeToolCalls',
        message: `Malformed tool call at index ${index}: missing function payload`,
      });
    }

    if (typeof toolCall.function.arguments !== 'string') {
      throw createAdapterParseError({
        code: PROVIDER_ADAPTER_ERROR_CODE.TOOL_PAYLOAD_PARSE,
        providerID,
        operation: 'normalizeToolCalls',
        message: `Malformed tool call at index ${index}: expected JSON string arguments`,
      });
    }

    try {
      return {
        id: typeof toolCall.id === 'string' ? toolCall.id : null,
        name: toolCall.function.name,
        arguments: JSON.parse(toolCall.function.arguments),
      };
    } catch (cause) {
      throw createAdapterParseError({
        code: PROVIDER_ADAPTER_ERROR_CODE.TOOL_PAYLOAD_PARSE,
        providerID,
        operation: 'normalizeToolCalls',
        message: `Malformed tool call at index ${index}: invalid JSON arguments`,
        cause,
      });
    }
  });
};

const normalizeToolCallsJsonObject = (providerID, toolCalls) => {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.map((toolCall, index) => {
    const args = toolCall?.function?.arguments;
    const hasArgsObject = args && typeof args === 'object' && !Array.isArray(args);
    if (!hasArgsObject) {
      throw createAdapterParseError({
        code: PROVIDER_ADAPTER_ERROR_CODE.TOOL_PAYLOAD_PARSE,
        providerID,
        operation: 'normalizeToolCalls',
        message: `Malformed tool call at index ${index}: expected JSON object arguments`,
      });
    }

    return {
      id: typeof toolCall.id === 'string' ? toolCall.id : null,
      name: toolCall.function.name,
      arguments: args,
    };
  });
};

const normalizeStructuredOutputJsonSchema = (providerID, payload) => {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload;
  }

  if (typeof payload !== 'string') {
    throw createAdapterParseError({
      code: PROVIDER_ADAPTER_ERROR_CODE.STRUCTURED_OUTPUT_PARSE,
      providerID,
      operation: 'normalizeStructuredOutput',
      message: 'Malformed structured output: expected JSON string or object payload',
    });
  }

  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('parsed payload is not a JSON object');
    }
    return parsed;
  } catch (cause) {
    throw createAdapterParseError({
      code: PROVIDER_ADAPTER_ERROR_CODE.STRUCTURED_OUTPUT_PARSE,
      providerID,
      operation: 'normalizeStructuredOutput',
      message: 'Malformed structured output: invalid JSON object string',
      cause,
    });
  }
};

const normalizeStructuredOutputJsonObject = (providerID, payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw createAdapterParseError({
      code: PROVIDER_ADAPTER_ERROR_CODE.STRUCTURED_OUTPUT_PARSE,
      providerID,
      operation: 'normalizeStructuredOutput',
      message: 'Malformed structured output: expected JSON object payload',
    });
  }
  return payload;
};

const createOpenAiFamilyAdapter = ({ providerID, options = {}, endpointDefaults }) => {
  const dependencies = {
    getProviderAuth: options.getProviderAuth ?? getProviderAuth,
    getProviderSources: options.getProviderSources ?? getProviderSources,
    resolveOpenCodeEnvConfig: options.resolveOpenCodeEnvConfig ?? resolveOpenCodeEnvConfig,
  };

  const capability = normalizeCapabilityMatrix()[providerID];
  const resolveContext = createProviderContextResolver({ providerID, dependencies, options });

  const resolveBaseUrl = () => {
    const context = resolveContext();
    return normalizeBaseUrl(options.baseUrl || context.baseUrlFromAuth, DEFAULT_BASE_URL[providerID]);
  };

  const resolveAuthHeaders = () => {
    const context = resolveContext();
    if (!context.apiKey) {
      throw createAdapterParseError({
        code: PROVIDER_ADAPTER_ERROR_CODE.AUTH_CONFIGURATION,
        providerID,
        operation: 'buildAuthHeaders',
        message: `Missing API key for provider ${providerID}`,
      });
    }

    return {
      Authorization: `Bearer ${context.apiKey}`,
    };
  };

  return {
    providerID,
    adapterVersion: PROVIDER_ADAPTER_VERSION,
    supportsStreaming: capability.streaming,
    supportsTools: capability.tools.supported,
    supportsImages: false,
    capabilities: capability,
    getProviderContext: resolveContext,
    buildAuthHeaders: resolveAuthHeaders,
    buildModelsListRequest() {
      return {
        method: 'GET',
        baseUrl: resolveBaseUrl(),
        path: endpointDefaults.models,
        headers: resolveAuthHeaders(),
      };
    },
    buildChatRequest(payload = {}) {
      const normalizedPayload = payload && typeof payload === 'object' ? payload : {};
      return {
        method: 'POST',
        baseUrl: resolveBaseUrl(),
        path: endpointDefaults.chat,
        headers: {
          'Content-Type': 'application/json',
          ...resolveAuthHeaders(),
        },
        body: {
          model: normalizedPayload.model,
          messages: Array.isArray(normalizedPayload.messages) ? normalizedPayload.messages : [],
          stream: normalizedPayload.stream !== false,
          tools: Array.isArray(normalizedPayload.tools) ? normalizedPayload.tools : undefined,
          response_format: normalizedPayload.responseFormat ?? undefined,
        },
      };
    },
    parseStream(streamText) {
      try {
        return parseOpenAiSseStream(streamText);
      } catch (cause) {
        throw createAdapterParseError({
          code: PROVIDER_ADAPTER_ERROR_CODE.STREAM_PARSE,
          providerID,
          operation: 'parseStream',
          message: `Failed to parse OpenAI-compatible stream for ${providerID}`,
          cause,
        });
      }
    },
    normalizeToolCalls(toolCalls) {
      return normalizeToolCallsJsonString(providerID, toolCalls);
    },
    normalizeStructuredOutput(payload) {
      return normalizeStructuredOutputJsonSchema(providerID, payload);
    },
  };
};

export function createOpenAiCompatibleAdapter(options = {}) {
  return createOpenAiFamilyAdapter({
    providerID: 'openai',
    options,
    endpointDefaults: {
      chat: '/v1/chat/completions',
      models: '/v1/models',
    },
  });
}

export function createLiteLlmAdapter(options = {}) {
  return createOpenAiFamilyAdapter({
    providerID: 'litellm',
    options,
    endpointDefaults: {
      chat: '/chat/completions',
      models: '/models',
    },
  });
}

export function createOllamaAdapter(options = {}) {
  const dependencies = {
    getProviderAuth: options.getProviderAuth ?? getProviderAuth,
    getProviderSources: options.getProviderSources ?? getProviderSources,
    resolveOpenCodeEnvConfig: options.resolveOpenCodeEnvConfig ?? resolveOpenCodeEnvConfig,
  };
  const providerID = 'ollama';
  const capability = normalizeCapabilityMatrix()[providerID];
  const resolveContext = createProviderContextResolver({ providerID, dependencies, options });

  const resolveBaseUrl = () => {
    const context = resolveContext();
    return normalizeBaseUrl(options.baseUrl || context.baseUrlFromAuth, DEFAULT_BASE_URL.ollama);
  };

  return {
    providerID,
    adapterVersion: PROVIDER_ADAPTER_VERSION,
    supportsStreaming: capability.streaming,
    supportsTools: capability.tools.supported,
    supportsImages: true,
    capabilities: capability,
    getProviderContext: resolveContext,
    buildAuthHeaders() {
      return {};
    },
    buildModelsListRequest() {
      return {
        method: 'GET',
        baseUrl: resolveBaseUrl(),
        path: '/api/tags',
        headers: {},
      };
    },
    buildChatRequest(payload = {}) {
      const normalizedPayload = payload && typeof payload === 'object' ? payload : {};
      return {
        method: 'POST',
        baseUrl: resolveBaseUrl(),
        path: '/api/chat',
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          model: normalizedPayload.model,
          messages: Array.isArray(normalizedPayload.messages) ? normalizedPayload.messages : [],
          stream: normalizedPayload.stream !== false,
          tools: Array.isArray(normalizedPayload.tools) ? normalizedPayload.tools : undefined,
          format: normalizedPayload.format ?? undefined,
        },
      };
    },
    parseStream(streamText) {
      try {
        return parseOllamaNdjsonStream(streamText);
      } catch (cause) {
        throw createAdapterParseError({
          code: PROVIDER_ADAPTER_ERROR_CODE.STREAM_PARSE,
          providerID,
          operation: 'parseStream',
          message: 'Failed to parse Ollama NDJSON stream',
          cause,
        });
      }
    },
    normalizeToolCalls(toolCalls) {
      return normalizeToolCallsJsonObject(providerID, toolCalls);
    },
    normalizeStructuredOutput(payload) {
      return normalizeStructuredOutputJsonObject(providerID, payload);
    },
  };
}
