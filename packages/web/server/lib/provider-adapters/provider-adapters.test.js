import { describe, expect, it } from 'bun:test';

import {
  LITELLM_COMPATIBLE_SSE_STREAM,
  MALFORMED_OLLAMA_TOOL_CALLS,
  MALFORMED_OPENAI_TOOL_CALLS,
  OLLAMA_NATIVE_NDJSON_STREAM,
  OLLAMA_NATIVE_TOOL_CALLS,
  OPENAI_COMPATIBLE_SSE_STREAM,
} from './fixtures/index.js';
import {
  PROVIDER_ADAPTER_ERROR_CODE,
  createLiteLlmAdapter,
  createOllamaAdapter,
  createOpenAiCompatibleAdapter,
} from './index.js';

const createDependencyStubs = (apiKey = 'test-api-key') => ({
  getProviderAuth: () => ({ apiKey }),
  getProviderSources: () => ({
    sources: {
      auth: { exists: true },
      user: { exists: true, path: '/tmp/opencode.json' },
      project: { exists: false, path: null },
      custom: { exists: false, path: null },
    },
  }),
  resolveOpenCodeEnvConfig: () => ({
    configuredOpenCodeHost: null,
    configuredOpenCodePort: null,
    effectivePort: null,
    configuredOpenCodeHostname: '127.0.0.1',
  }),
});

describe('provider adapters', () => {
  it('normalizes OpenAI-compatible adapter requests and streams', () => {
    const adapter = createOpenAiCompatibleAdapter(createDependencyStubs());
    const request = adapter.buildChatRequest({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    });

    expect(adapter.capabilities.streamProtocol).toBe('openai_sse');
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.headers.Authorization).toBe('Bearer test-api-key');
    expect(adapter.parseStream(OPENAI_COMPATIBLE_SSE_STREAM)).toHaveLength(1);
  });

  it('normalizes LiteLLM adapter requests and OpenAI-compatible SSE stream parsing', () => {
    const adapter = createLiteLlmAdapter(createDependencyStubs());
    const request = adapter.buildModelsListRequest();

    expect(adapter.capabilities.streamProtocol).toBe('openai_sse');
    expect(request.path).toBe('/models');
    expect(adapter.parseStream(LITELLM_COMPATIBLE_SSE_STREAM)).toHaveLength(1);
  });

  it('normalizes native Ollama adapter behavior without OpenAI endpoint semantics', () => {
    const adapter = createOllamaAdapter(createDependencyStubs());
    const request = adapter.buildChatRequest({
      model: 'llama3.1',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });

    expect(adapter.capabilities.streamProtocol).toBe('ollama_ndjson');
    expect(request.path).toBe('/api/chat');
    expect(adapter.buildModelsListRequest().path).toBe('/api/tags');
    expect(adapter.parseStream(OLLAMA_NATIVE_NDJSON_STREAM)).toHaveLength(2);
    expect(adapter.normalizeToolCalls(OLLAMA_NATIVE_TOOL_CALLS)[0].arguments.location).toBe('Seoul');
  });

  it('returns typed parse error for malformed OpenAI-compatible tool payload', () => {
    const adapter = createOpenAiCompatibleAdapter(createDependencyStubs());

    try {
      adapter.normalizeToolCalls(MALFORMED_OPENAI_TOOL_CALLS);
      throw new Error('expected normalizeToolCalls to throw');
    } catch (error) {
      expect(error.name).toBe('ProviderAdapterParseError');
      expect(error.code).toBe(PROVIDER_ADAPTER_ERROR_CODE.TOOL_PAYLOAD_PARSE);
      expect(error.providerID).toBe('openai');
    }
  });

  it('returns typed parse error for malformed Ollama native tool payload', () => {
    const adapter = createOllamaAdapter(createDependencyStubs());

    try {
      adapter.normalizeToolCalls(MALFORMED_OLLAMA_TOOL_CALLS);
      throw new Error('expected normalizeToolCalls to throw');
    } catch (error) {
      expect(error.name).toBe('ProviderAdapterParseError');
      expect(error.code).toBe(PROVIDER_ADAPTER_ERROR_CODE.TOOL_PAYLOAD_PARSE);
      expect(error.providerID).toBe('ollama');
    }
  });

  it('returns typed parse errors for stream protocol mismatch across OpenAI SSE and Ollama NDJSON', () => {
    const openAiAdapter = createOpenAiCompatibleAdapter(createDependencyStubs());
    const ollamaAdapter = createOllamaAdapter(createDependencyStubs());

    try {
      openAiAdapter.parseStream(OLLAMA_NATIVE_NDJSON_STREAM);
      throw new Error('expected openAiAdapter.parseStream to throw');
    } catch (error) {
      expect(error.name).toBe('ProviderAdapterParseError');
      expect(error.code).toBe(PROVIDER_ADAPTER_ERROR_CODE.STREAM_PARSE);
      expect(error.providerID).toBe('openai');
    }

    try {
      ollamaAdapter.parseStream(OPENAI_COMPATIBLE_SSE_STREAM);
      throw new Error('expected ollamaAdapter.parseStream to throw');
    } catch (error) {
      expect(error.name).toBe('ProviderAdapterParseError');
      expect(error.code).toBe(PROVIDER_ADAPTER_ERROR_CODE.STREAM_PARSE);
      expect(error.providerID).toBe('ollama');
    }
  });
});
