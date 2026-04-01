export const PROVIDER_STREAM_PROTOCOL = Object.freeze({
  OPENAI_SSE: 'openai_sse',
  OLLAMA_NDJSON: 'ollama_ndjson',
});

const DEFAULT_CAPABILITY_MATRIX = Object.freeze({
  openai: Object.freeze({
    chat: true,
    streaming: true,
    streamProtocol: PROVIDER_STREAM_PROTOCOL.OPENAI_SSE,
    modelsList: 'openai_models',
    auth: 'bearer',
    tools: Object.freeze({ supported: true, toolCallArguments: 'json_string' }),
    structuredOutput: 'json_schema',
  }),
  litellm: Object.freeze({
    chat: true,
    streaming: true,
    streamProtocol: PROVIDER_STREAM_PROTOCOL.OPENAI_SSE,
    modelsList: 'openai_models',
    auth: 'bearer',
    tools: Object.freeze({ supported: true, toolCallArguments: 'json_string' }),
    structuredOutput: 'json_schema',
  }),
  ollama: Object.freeze({
    chat: true,
    streaming: true,
    streamProtocol: PROVIDER_STREAM_PROTOCOL.OLLAMA_NDJSON,
    modelsList: 'ollama_tags',
    auth: 'none',
    tools: Object.freeze({ supported: true, toolCallArguments: 'json_object' }),
    structuredOutput: 'json_object',
  }),
});

/**
 * @param {Record<string, Partial<NormalizedProviderCapability>>=} input
 * @returns {Record<string, NormalizedProviderCapability>}
 */
export function normalizeCapabilityMatrix(input = {}) {
  const allProviderKeys = new Set([...Object.keys(DEFAULT_CAPABILITY_MATRIX), ...Object.keys(input)]);
  const normalized = {};

  for (const providerID of allProviderKeys) {
    const defaults = DEFAULT_CAPABILITY_MATRIX[providerID] ?? {
      chat: false,
      streaming: false,
      streamProtocol: null,
      modelsList: 'unknown',
      auth: 'unknown',
      tools: { supported: false, toolCallArguments: 'unsupported' },
      structuredOutput: 'unsupported',
    };

    const override = input[providerID] ?? {};
    const toolsOverride = override.tools ?? {};
    const merged = {
      chat: override.chat ?? defaults.chat,
      streaming: override.streaming ?? defaults.streaming,
      streamProtocol: override.streamProtocol ?? defaults.streamProtocol,
      modelsList: override.modelsList ?? defaults.modelsList,
      auth: override.auth ?? defaults.auth,
      tools: {
        supported: toolsOverride.supported ?? defaults.tools.supported,
        toolCallArguments: toolsOverride.toolCallArguments ?? defaults.tools.toolCallArguments,
      },
      structuredOutput: override.structuredOutput ?? defaults.structuredOutput,
    };

    if (
      merged.streamProtocol !== null &&
      merged.streamProtocol !== PROVIDER_STREAM_PROTOCOL.OPENAI_SSE &&
      merged.streamProtocol !== PROVIDER_STREAM_PROTOCOL.OLLAMA_NDJSON
    ) {
      throw new Error(`Unsupported stream protocol for ${providerID}: ${String(merged.streamProtocol)}`);
    }

    normalized[providerID] = merged;
  }

  return normalized;
}

/**
 * @param {string} text
 * @returns {ReadonlyArray<Record<string, unknown>>}
 */
export function parseOpenAiSseStream(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('SSE protocol mismatch: expected non-empty stream text');
  }

  const blocks = text.replace(/\r\n/g, '\n').split('\n\n');
  const chunks = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim());
    const dataLines = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .filter(Boolean);

    if (dataLines.length === 0) {
      continue;
    }

    const payloadText = dataLines.join('\n');
    if (payloadText === '[DONE]') {
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      throw new Error('SSE protocol mismatch: data line is not valid JSON payload');
    }

    const hasOpenAiChunkShape =
      payload &&
      typeof payload === 'object' &&
      payload.object === 'chat.completion.chunk' &&
      Array.isArray(payload.choices) &&
      payload.choices.length > 0 &&
      payload.choices[0] &&
      typeof payload.choices[0] === 'object' &&
      payload.choices[0].delta &&
      typeof payload.choices[0].delta === 'object';

    if (!hasOpenAiChunkShape) {
      throw new Error('SSE protocol mismatch: expected OpenAI chat.completion.chunk delta payload');
    }

    chunks.push(payload);
  }

  if (chunks.length === 0) {
    throw new Error('SSE protocol mismatch: no data chunks parsed');
  }

  return chunks;
}

/**
 * @param {string} text
 * @returns {ReadonlyArray<Record<string, unknown>>}
 */
export function parseOllamaNdjsonStream(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('NDJSON protocol mismatch: expected non-empty stream text');
  }

  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error('NDJSON protocol mismatch: no JSON lines found');
  }

  const chunks = [];

  for (const line of lines) {
    if (line.startsWith('data:')) {
      throw new Error('NDJSON protocol mismatch: received SSE data line');
    }

    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      throw new Error('NDJSON protocol mismatch: line is not valid JSON');
    }

    const hasOllamaStreamShape = payload && typeof payload === 'object' && typeof payload.done === 'boolean';
    if (!hasOllamaStreamShape) {
      throw new Error('NDJSON protocol mismatch: expected Ollama done marker per line');
    }

    chunks.push(payload);
  }

  return chunks;
}

/**
 * @typedef {'openai_sse' | 'ollama_ndjson' | null} StreamProtocol
 */

/**
 * @typedef {'openai_models' | 'ollama_tags' | 'unknown'} ModelsListFamily
 */

/**
 * @typedef {'bearer' | 'none' | 'unknown'} AuthScheme
 */

/**
 * @typedef {'json_string' | 'json_object' | 'unsupported'} ToolCallArgumentsMode
 */

/**
 * @typedef {'json_schema' | 'json_object' | 'unsupported'} StructuredOutputMode
 */

/**
 * @typedef {{
 *   chat: boolean;
 *   streaming: boolean;
 *   streamProtocol: StreamProtocol;
 *   modelsList: ModelsListFamily;
 *   auth: AuthScheme;
 *   tools: { supported: boolean; toolCallArguments: ToolCallArgumentsMode };
 *   structuredOutput: StructuredOutputMode;
 * }} NormalizedProviderCapability
 */
