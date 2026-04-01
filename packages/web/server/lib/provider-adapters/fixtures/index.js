import {
  LITELLM_SSE_STREAM,
  OLLAMA_NDJSON_CHUNKS,
  OLLAMA_NDJSON_STREAM,
  OPENAI_SSE_STREAM,
} from '../../provider-conformance/fixtures.js';

export const OPENAI_COMPATIBLE_SSE_STREAM = OPENAI_SSE_STREAM;
export const LITELLM_COMPATIBLE_SSE_STREAM = LITELLM_SSE_STREAM;
export const OLLAMA_NATIVE_NDJSON_STREAM = OLLAMA_NDJSON_STREAM;
export const OLLAMA_NATIVE_TOOL_CALLS = OLLAMA_NDJSON_CHUNKS[0].message.tool_calls;

export const MALFORMED_OPENAI_TOOL_CALLS = Object.freeze([
  Object.freeze({
    id: 'call-openai-malformed',
    function: Object.freeze({
      name: 'weather',
      arguments: '{"location":',
    }),
  }),
]);

export const MALFORMED_OLLAMA_TOOL_CALLS = Object.freeze([
  Object.freeze({
    function: Object.freeze({
      name: 'weather',
      arguments: 'not-object',
    }),
  }),
]);
