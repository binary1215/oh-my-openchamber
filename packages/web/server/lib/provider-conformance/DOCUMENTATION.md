# Provider Conformance Module Documentation

## Purpose
This module defines a normalized provider capability matrix and fixture-based stream parsers for OpenAI-compatible SSE and Ollama NDJSON contracts. It is intentionally contract-first and does not perform network calls or provider adapter execution.

## Entrypoints and structure
- `packages/web/server/lib/provider-conformance/index.js`: Capability normalization, stream protocol constants, and fixture parser helpers.
- `packages/web/server/lib/provider-conformance/fixtures.js`: Literal OpenAI/LiteLLM SSE and Ollama NDJSON stream payload fixtures.
- `packages/web/server/lib/provider-conformance/provider-conformance.test.js`: Bun tests covering matrix semantics, protocol mismatch detection, and tool-call argument normalization.

## Normalized capability shape
`normalizeCapabilityMatrix(input)` outputs a per-provider object with explicit fields:
- `chat`: boolean
- `streaming`: boolean
- `streamProtocol`: `openai_sse` or `ollama_ndjson`
- `modelsList`: endpoint family (`openai_models` or `ollama_tags`)
- `auth`: auth scheme (`bearer`, `none`, or `unknown`)
- `tools`: object with `supported` and `toolCallArguments`
- `structuredOutput`: structured output mode for negotiation checks

## Fixture parser contracts
- `parseOpenAiSseStream(text)` expects SSE blocks containing `data:` JSON entries shaped like `chat.completion.chunk` with `choices[0].delta`.
- `parseOllamaNdjsonStream(text)` expects newline-delimited JSON objects with explicit `done: boolean` markers.

Both parsers raise protocol mismatch errors when the other provider's stream format is supplied.
