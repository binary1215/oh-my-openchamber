# Provider Adapters Module Documentation

## Purpose
This module provides concrete provider adapters for OpenAI-compatible APIs, LiteLLM, and native Ollama while preserving the capability semantics defined by `provider-conformance`.

## Entrypoints and structure
- `packages/web/server/lib/provider-adapters/index.js`: adapter factories, typed parse errors, request/auth/base URL normalization, stream parser bridging, and tool/structured payload normalization.
- `packages/web/server/lib/provider-adapters/fixtures/index.js`: reusable adapter fixtures for happy-path and malformed payload tests.
- `packages/web/server/lib/provider-adapters/provider-adapters.test.js`: Bun tests covering adapter behavior and protocol/tool payload error typing.

## Public factories
- `createOpenAiCompatibleAdapter(options?)`
- `createLiteLlmAdapter(options?)`
- `createOllamaAdapter(options?)`

All adapters expose a unified shape with:
- `providerID`, `adapterVersion`
- `capabilities` (from `normalizeCapabilityMatrix()`)
- `buildAuthHeaders()`, `buildChatRequest(payload)`, `buildModelsListRequest()`
- `parseStream(streamText)`
- `normalizeToolCalls(toolCalls)`
- `normalizeStructuredOutput(payload)`

## Conformance and boundary integrations
- Reuses conformance helpers from `packages/web/server/lib/provider-conformance/index.js`:
  - `normalizeCapabilityMatrix`
  - `parseOpenAiSseStream`
  - `parseOllamaNdjsonStream`
- Reuses OpenCode boundaries for provider context/auth/env:
  - `packages/web/server/lib/opencode/providers.js`
  - `packages/web/server/lib/opencode/auth.js`
  - `packages/web/server/lib/opencode/env-config.js`

## Typed parse errors
Adapter parse/normalization failures are surfaced as `ProviderAdapterParseError` with fields:
- `name`
- `code` (`PROVIDER_ADAPTER_ERROR_CODE.*`)
- `providerID`
- `operation`
- `cause` (when available)

This keeps protocol mismatches and malformed tool payloads explicit at the adapter boundary.
