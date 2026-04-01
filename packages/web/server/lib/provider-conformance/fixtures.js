export const OPENAI_SSE_CHUNK = Object.freeze({
  id: 'chatcmpl-openai-1',
  object: 'chat.completion.chunk',
  model: 'gpt-4.1-mini',
  choices: [
    {
      index: 0,
      delta: {
        role: 'assistant',
        content: 'Hello from OpenAI stream',
      },
      finish_reason: null,
    },
  ],
});

export const OPENAI_SSE_STREAM = `event: message\ndata: ${JSON.stringify(OPENAI_SSE_CHUNK)}\n\ndata: [DONE]\n\n`;

export const LITELLM_SSE_CHUNK = Object.freeze({
  id: 'chatcmpl-litellm-1',
  object: 'chat.completion.chunk',
  model: 'gpt-4o-mini',
  choices: [
    {
      index: 0,
      delta: {
        role: 'assistant',
        content: 'Hello from LiteLLM stream',
      },
      finish_reason: null,
    },
  ],
});

export const LITELLM_SSE_STREAM = `event: message\ndata: ${JSON.stringify(LITELLM_SSE_CHUNK)}\n\ndata: [DONE]\n\n`;

export const OLLAMA_NDJSON_CHUNKS = Object.freeze([
  Object.freeze({
    model: 'llama3.1',
    created_at: '2026-04-02T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: 'Hello from Ollama stream',
      tool_calls: [
        {
          function: {
            name: 'weather',
            arguments: {
              location: 'Seoul',
            },
          },
        },
      ],
    },
    done: false,
  }),
  Object.freeze({
    model: 'llama3.1',
    created_at: '2026-04-02T00:00:00.100Z',
    done: true,
    done_reason: 'stop',
  }),
]);

export const OLLAMA_NDJSON_STREAM = `${JSON.stringify(OLLAMA_NDJSON_CHUNKS[0])}\n${JSON.stringify(OLLAMA_NDJSON_CHUNKS[1])}\n`;
