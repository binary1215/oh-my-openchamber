import { describe, expect, it } from 'bun:test';

import {
  LITELLM_SSE_STREAM,
  OLLAMA_NDJSON_STREAM,
  OPENAI_SSE_STREAM,
} from './fixtures.js';
import {
  PROVIDER_STREAM_PROTOCOL,
  normalizeCapabilityMatrix,
  parseOllamaNdjsonStream,
  parseOpenAiSseStream,
} from './index.js';

describe('provider conformance', () => {
  it('normalizes capability matrix and differentiates OpenAI/LiteLLM vs Ollama', () => {
    const matrix = normalizeCapabilityMatrix();

    expect(matrix.openai.chat).toBe(true);
    expect(matrix.litellm.chat).toBe(true);
    expect(matrix.ollama.chat).toBe(true);

    expect(matrix.openai.streamProtocol).toBe(PROVIDER_STREAM_PROTOCOL.OPENAI_SSE);
    expect(matrix.litellm.streamProtocol).toBe(PROVIDER_STREAM_PROTOCOL.OPENAI_SSE);
    expect(matrix.ollama.streamProtocol).toBe(PROVIDER_STREAM_PROTOCOL.OLLAMA_NDJSON);

    expect(matrix.openai.modelsList).toBe('openai_models');
    expect(matrix.litellm.modelsList).toBe('openai_models');
    expect(matrix.ollama.modelsList).toBe('ollama_tags');

    expect(matrix.openai.auth).toBe('bearer');
    expect(matrix.litellm.auth).toBe('bearer');
    expect(matrix.ollama.auth).toBe('none');
  });

  it('detects streaming protocol mismatch across SSE and NDJSON parsers', () => {
    expect(() => parseOpenAiSseStream(OLLAMA_NDJSON_STREAM)).toThrow('SSE protocol mismatch');
    expect(() => parseOllamaNdjsonStream(OPENAI_SSE_STREAM)).toThrow('NDJSON protocol mismatch');
  });

  it('parses OpenAI-compatible SSE chunks for OpenAI and LiteLLM fixtures', () => {
    const openAiChunks = parseOpenAiSseStream(OPENAI_SSE_STREAM);
    const liteLlmChunks = parseOpenAiSseStream(LITELLM_SSE_STREAM);

    expect(openAiChunks).toHaveLength(1);
    expect(liteLlmChunks).toHaveLength(1);

    expect(openAiChunks[0].object).toBe('chat.completion.chunk');
    expect(liteLlmChunks[0].object).toBe('chat.completion.chunk');
  });

  it('encodes tool-call argument normalization rule by provider family', () => {
    const matrix = normalizeCapabilityMatrix();

    expect(matrix.openai.tools.toolCallArguments).toBe('json_string');
    expect(matrix.litellm.tools.toolCallArguments).toBe('json_string');
    expect(matrix.ollama.tools.toolCallArguments).toBe('json_object');
  });
});
