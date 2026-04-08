import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { registerRuntimeRoutes } from '../opencode/runtime-routes.js';
import { registerOpenCodeRoutes } from '../opencode/routes.js';
import { createRuntimeBackend } from './index.js';

const createTempDirectory = async () => fsPromises.mkdtemp(path.join(os.tmpdir(), 'backend-runtime-'));

const createOpenCodeRouteDependencies = () => ({
  crypto: { randomUUID: () => 'project-uuid-1' },
  clientReloadDelayMs: 250,
  getOpenCodeResolutionSnapshot: async () => ({ status: 'ok' }),
  formatSettingsResponse: (settings) => settings,
  readSettingsFromDisk: async () => ({ projects: [] }),
  readSettingsFromDiskMigrated: async () => ({ projects: [] }),
  persistSettings: async (input) => ({ ...input }),
  sanitizeProjects: (projects) => projects,
  validateDirectoryPath: async (requestedPath) => ({ ok: true, directory: requestedPath }),
  resolveProjectDirectory: async () => ({ directory: null, error: 'No directory supplied' }),
  buildOpenCodeUrl: (routePath) => `http://127.0.0.1:65535${routePath}`,
  getOpenCodeAuthHeaders: () => ({}),
  getProviderSources: (providerID) => ({
    sources: {
      auth: { exists: false },
      user: { exists: false, path: null },
      project: { exists: false, path: null },
      custom: { exists: false, path: null },
    },
    providerID,
  }),
  removeProviderConfig: () => false,
  upsertProviderConfig: (providerID) => ({ providerId: providerID, scope: 'user', path: '/tmp/config.json' }),
  refreshOpenCodeAfterConfigChange: async () => {},
});

const listenOnEphemeralPort = async (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve server address'));
        return;
      }

      resolve({
        host: address.address,
        port: address.port,
      });
    });
  });

const closeServer = async (server) =>
  new Promise((resolve, reject) => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
    server.close((error) => {
      if (error) {
        if (error.code === 'ERR_SERVER_NOT_RUNNING') {
          resolve();
          return;
        }
        reject(error);
        return;
      }
      resolve();
    });
  });

const waitFor = async (predicate, timeoutMs = 3_000, intervalMs = 50) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Timed out waiting for condition');
};

const readSseUntilMarkers = async (response, markers) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 3_000;

  while (Date.now() < deadline) {
    const readResult = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timed out waiting for SSE data')), 1_500);
      }),
    ]);

    if (readResult.done) {
      break;
    }

    text += decoder.decode(readResult.value, { stream: true });

    let matchedAll = true;
    for (const marker of markers) {
      if (!text.includes(marker)) {
        matchedAll = false;
        break;
      }
    }
    if (matchedAll) {
      break;
    }
  }

  reader.cancel().catch(() => {});
  return text;
};

const testServers = [];

afterEach(async () => {
  while (testServers.length > 0) {
    const server = testServers.pop();
    await closeServer(server);
  }
});

describe('backend runtime integration', () => {
  it('integrates runtime endpoints, SSE stream, capability negotiation, and artifact fetch', async () => {
    const baseDirectory = await createTempDirectory();
    const runtimeBackend = createRuntimeBackend({
      fsPromises,
      path,
      baseDirectory,
      providerAdapterOptions: {
        getProviderAuth: () => ({ apiKey: 'test-api-key' }),
        getProviderSources: () => ({ sources: { auth: { exists: true } } }),
        resolveOpenCodeEnvConfig: () => ({ configuredOpenCodeHost: null }),
      },
    });

    await runtimeBackend.artifactStore.writeArtifact('evidence', 'runtime-artifact.txt', 'artifact-ready');

    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, createOpenCodeRouteDependencies());
    registerRuntimeRoutes(app, { runtimeBackend });

    const server = http.createServer(app);
    testServers.push(server);
    const address = await listenOnEphemeralPort(server);
    const baseUrl = `http://${address.host}:${address.port}`;

    const sessionResponse = await fetch(`${baseUrl}/api/opencode/runtime/create-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { source: 'integration-test' } }),
    });
    expect(sessionResponse.status).toBe(200);
    const sessionPayload = await sessionResponse.json();
    expect(sessionPayload.session.sessionID).toMatch(/^runtime-session-/);
    expect(sessionPayload.policyAction.action).toBe('create_plan');

    const sseController = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/opencode/runtime/subscribe-events`, {
      headers: { Accept: 'text/event-stream' },
      signal: sseController.signal,
    });
    expect(sseResponse.status).toBe(200);

    const sseEventsPromise = readSseUntilMarkers(sseResponse, ['"type":"task.enqueued"', '"type":"task.started"']);

    const runTaskResponse = await fetch(`${baseUrl}/api/opencode/runtime/run-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metadata: { scenario: 'run-task-with-tool' },
        providerID: 'openai',
        requiredCapabilities: ['chat', 'tools', 'images'],
        degradableCapabilities: ['images'],
        toolInvocation: {
          toolName: 'runtime.echo',
          input: { hello: 'runtime' },
          requiresApproval: true,
          autoApprove: true,
        },
      }),
    });

    expect(runTaskResponse.status).toBe(200);
    const runTaskPayload = await runTaskResponse.json();
    expect(runTaskPayload.task.status).toBe('completed');
    expect(runTaskPayload.toolResult.status).toBe('completed');
    expect(runTaskPayload.negotiation.outcome).toBe('degrade');
    expect(runTaskPayload.negotiation.missingCapabilities).toContain('images');

    const sseText = await sseEventsPromise;
    expect(sseText).toContain('"type":"task.enqueued"');
    expect(sseText).toContain('"type":"task.started"');
    sseController.abort();

    const runningTaskResponse = await fetch(`${baseUrl}/api/opencode/runtime/run-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { scenario: 'cancel-me' } }),
    });
    expect(runningTaskResponse.status).toBe(200);
    const runningTaskPayload = await runningTaskResponse.json();
    expect(runningTaskPayload.task.status).toBe('running');

    const cancelResponse = await fetch(`${baseUrl}/api/opencode/runtime/cancel-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskID: runningTaskPayload.task.taskID, reason: 'integration-cancel' }),
    });
    expect(cancelResponse.status).toBe(200);
    const cancelPayload = await cancelResponse.json();
    expect(cancelPayload.task.status).toBe('cancelled');

    const negotiationResponse = await fetch(`${baseUrl}/api/opencode/runtime/provider-negotiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerID: 'openai',
        requiredCapabilities: ['chat', 'images'],
        degradableCapabilities: ['images'],
      }),
    });
    expect(negotiationResponse.status).toBe(200);
    const negotiationPayload = await negotiationResponse.json();
    expect(negotiationPayload.outcome).toBe('degrade');
    expect(negotiationPayload.degradedCapabilities).toContain('images');

    const artifactResponse = await fetch(`${baseUrl}/api/opencode/runtime/artifacts/evidence/runtime-artifact.txt`);
    expect(artifactResponse.status).toBe(200);
    const artifactPayload = await artifactResponse.json();
    expect(artifactPayload.category).toBe('evidence');
    expect(artifactPayload.content).toBe('artifact-ready');
  }, 20_000);

  it('keeps existing provider source endpoint response shape intact', async () => {
    const baseDirectory = await createTempDirectory();
    const runtimeBackend = createRuntimeBackend({ fsPromises, path, baseDirectory });

    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, createOpenCodeRouteDependencies());
    registerRuntimeRoutes(app, { runtimeBackend });

    const server = http.createServer(app);
    testServers.push(server);
    const address = await listenOnEphemeralPort(server);
    const baseUrl = `http://${address.host}:${address.port}`;

    const response = await fetch(`${baseUrl}/api/provider/openai/source`);
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.providerId).toBe('openai');
    expect(payload.sources).toEqual({
      auth: { exists: expect.any(Boolean) },
      user: { exists: false, path: null },
      project: { exists: false, path: null },
      custom: { exists: false, path: null },
    });
  });

  it('exposes runtime-managed providers in provider catalog route', async () => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, createOpenCodeRouteDependencies());

    const server = http.createServer(app);
    testServers.push(server);
    const address = await listenOnEphemeralPort(server);
    const baseUrl = `http://${address.host}:${address.port}`;

    const response = await fetch(`${baseUrl}/api/provider`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(Array.isArray(payload.all)).toBe(true);
    expect(payload.all.some((provider) => provider.id === 'ollama')).toBe(true);
    expect(payload.all.some((provider) => provider.id === 'litellm')).toBe(true);
  });

  it('connects a runtime-managed provider through local connect route', async () => {
    const dependencies = createOpenCodeRouteDependencies();
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, dependencies);

    const server = http.createServer(app);
    testServers.push(server);
    const address = await listenOnEphemeralPort(server);
    const baseUrl = `http://${address.host}:${address.port}`;

    const response = await fetch(`${baseUrl}/api/provider/ollama/connect`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      success: true,
      providerId: 'ollama',
      connected: true,
      requiresReload: true,
      reloadDelayMs: 250,
      config: {
        providerId: 'ollama',
        scope: 'user',
        path: '/tmp/config.json',
      },
    });
  });

  it('saves provider auth with baseURL and apiKey through auth route', async () => {
    const dependencies = {
      ...createOpenCodeRouteDependencies(),
    };

    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, dependencies);

    const authModule = await import('../opencode/auth.js');
    const authFilePath = authModule.AUTH_FILE;
    let backup = null;

    try {
      backup = await fsPromises.readFile(authFilePath, 'utf8');
    } catch {
      backup = null;
    }

    try {
      const server = http.createServer(app);
      testServers.push(server);
      const address = await listenOnEphemeralPort(server);
      const baseUrl = `http://${address.host}:${address.port}`;

      const response = await fetch(`${baseUrl}/api/auth/ollama`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'api', key: 'secret', baseURL: 'http://127.0.0.1:11434' }),
      });

      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.success).toBe(true);
      const written = JSON.parse(await fsPromises.readFile(authFilePath, 'utf8'));
      expect(written.ollama).toEqual({
        apiKey: 'secret',
        baseURL: 'http://127.0.0.1:11434',
      });
    } finally {
      if (backup === null) {
        await fsPromises.rm(authFilePath, { force: true });
      } else {
        await fsPromises.writeFile(authFilePath, backup, 'utf8');
      }
    }
  });

  it('exposes canonical provider models for runtime-managed providers without dropping existing providers', async () => {
    const upstreamApp = express();
    upstreamApp.get('/config/providers', (_req, res) => {
      res.json({
        providers: [
          {
            id: 'openai',
            name: 'OpenAI',
            models: {
              'gpt-4.1-mini': { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
            },
          },
        ],
        default: { chat: 'openai/gpt-4.1-mini' },
      });
    });

    const upstreamServer = http.createServer(upstreamApp);
    testServers.push(upstreamServer);
    const upstreamAddress = await listenOnEphemeralPort(upstreamServer);
    const upstreamBaseUrl = `http://${upstreamAddress.host}:${upstreamAddress.port}`;

    const providerApp = express();
    providerApp.get('/models', (req, res) => {
      if (req.headers.authorization !== 'Bearer secret') {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      return res.json({
        data: [
          { id: 'litellm/claude-3.7', name: 'Claude 3.7 Sonnet' },
        ],
      });
    });

    const providerServer = http.createServer(providerApp);
    testServers.push(providerServer);
    const providerAddress = await listenOnEphemeralPort(providerServer);
    const providerBaseUrl = `http://${providerAddress.host}:${providerAddress.port}`;

    const dependencies = {
      ...createOpenCodeRouteDependencies(),
      buildOpenCodeUrl: (routePath) => `${upstreamBaseUrl}${routePath}`,
    };

    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, dependencies);

    const authModule = await import('../opencode/auth.js');
    const authFilePath = authModule.AUTH_FILE;
    let backup = null;

    try {
      backup = await fsPromises.readFile(authFilePath, 'utf8');
    } catch {
      backup = null;
    }

    try {
      await fsPromises.mkdir(path.dirname(authFilePath), { recursive: true });
      await fsPromises.writeFile(authFilePath, JSON.stringify({
        litellm: {
          apiKey: 'secret',
          baseURL: providerBaseUrl,
        },
      }), 'utf8');

      const server = http.createServer(app);
      testServers.push(server);
      const address = await listenOnEphemeralPort(server);
      const baseUrl = `http://${address.host}:${address.port}`;

      const firstResponse = await fetch(`${baseUrl}/api/config/providers`);
      expect(firstResponse.status).toBe(200);
      const firstPayload = await firstResponse.json();
      const firstLiteLlm = firstPayload.providers.find((provider) => provider.id === 'litellm');
      expect(firstPayload.providers.some((provider) => provider.id === 'openai')).toBe(true);
      expect(firstLiteLlm.discovery.state).toBe('discovering');

      const finalLiteLlm = await waitFor(async () => {
        const response = await fetch(`${baseUrl}/api/config/providers`);
        const payload = await response.json();
        const provider = payload.providers.find((entry) => entry.id === 'litellm');
        return provider?.discovery?.state === 'ready' ? provider : null;
      });

      expect(finalLiteLlm.models['litellm/claude-3.7']).toEqual({
        id: 'litellm/claude-3.7',
        providerID: 'litellm',
        name: 'Claude 3.7 Sonnet',
        family: 'external',
        api: {
          id: 'litellm/claude-3.7',
          npm: '@ai-sdk/openai-compatible',
        },
        status: 'active',
        headers: {},
        options: {},
        cost: {
          input: 0,
          output: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        limit: {
          context: 0,
          output: 0,
        },
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: {
            text: true,
            audio: false,
            image: false,
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
        },
        variants: {},
      });
    } finally {
      if (backup === null) {
        await fsPromises.rm(authFilePath, { force: true });
      } else {
        await fsPromises.writeFile(authFilePath, backup, 'utf8');
      }
    }
  });

  it('classifies empty runtime-managed discovery responses as empty', async () => {
    const upstreamApp = express();
    upstreamApp.get('/config/providers', (_req, res) => {
      res.json({ providers: [], default: {} });
    });

    const upstreamServer = http.createServer(upstreamApp);
    testServers.push(upstreamServer);
    const upstreamAddress = await listenOnEphemeralPort(upstreamServer);
    const upstreamBaseUrl = `http://${upstreamAddress.host}:${upstreamAddress.port}`;

    const providerApp = express();
    providerApp.get('/api/tags', (_req, res) => {
      res.json({ models: [] });
    });

    const providerServer = http.createServer(providerApp);
    testServers.push(providerServer);
    const providerAddress = await listenOnEphemeralPort(providerServer);
    const providerBaseUrl = `http://${providerAddress.host}:${providerAddress.port}`;

    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, {
      ...createOpenCodeRouteDependencies(),
      buildOpenCodeUrl: (routePath) => `${upstreamBaseUrl}${routePath}`,
    });

    const authModule = await import('../opencode/auth.js');
    const authFilePath = authModule.AUTH_FILE;
    let backup = null;

    try {
      backup = await fsPromises.readFile(authFilePath, 'utf8');
    } catch {
      backup = null;
    }

    try {
      await fsPromises.mkdir(path.dirname(authFilePath), { recursive: true });
      await fsPromises.writeFile(authFilePath, JSON.stringify({
        ollama: {
          baseURL: providerBaseUrl,
        },
      }), 'utf8');

      const server = http.createServer(app);
      testServers.push(server);
      const address = await listenOnEphemeralPort(server);
      const baseUrl = `http://${address.host}:${address.port}`;

      const provider = await waitFor(async () => {
        const response = await fetch(`${baseUrl}/api/config/providers`);
        const payload = await response.json();
        const entry = payload.providers.find((candidate) => candidate.id === 'ollama');
        return entry?.discovery?.state === 'empty' ? entry : null;
      });

      expect(provider.discovery).toEqual({
        state: 'empty',
        errorType: null,
        message: null,
      });
      expect(provider.models).toEqual({});
    } finally {
      if (backup === null) {
        await fsPromises.rm(authFilePath, { force: true });
      } else {
        await fsPromises.writeFile(authFilePath, backup, 'utf8');
      }
    }
  });

  it('persists runtime-managed provider config when saving auth', async () => {
    const upsertCalls = [];

    const app = express();
    app.use(express.json());
    registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, {
      ...createOpenCodeRouteDependencies(),
      upsertProviderConfig: (providerID, workingDirectory, scope, providerConfig) => {
        upsertCalls.push({ providerID, workingDirectory, scope, providerConfig });
        return { providerId: providerID, scope, path: '/tmp/config.json' };
      },
      removeProviderConfig: () => {
        throw new Error('removeProviderConfig should not be called for runtime-managed auth saves');
      },
    });

    const server = http.createServer(app);
    testServers.push(server);
    const address = await listenOnEphemeralPort(server);
    const baseUrl = `http://${address.host}:${address.port}`;

    const response = await fetch(`${baseUrl}/api/auth/litellm`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'api',
        key: 'secret',
        baseURL: 'http://192.168.0.8:4000/v1',
      }),
    });

    expect(response.status).toBe(200);
    expect(upsertCalls).toEqual([
      {
        providerID: 'litellm',
        workingDirectory: null,
        scope: 'user',
        providerConfig: {},
      },
    ]);
  });

  it('rehydrates missing runtime-managed provider config from saved auth during canonical provider load', async () => {
    const upstreamApp = express();
    upstreamApp.get('/config/providers', (_req, res) => {
      res.json({ providers: [], default: {} });
    });

    const upstreamServer = http.createServer(upstreamApp);
    testServers.push(upstreamServer);
    const upstreamAddress = await listenOnEphemeralPort(upstreamServer);
    const upstreamBaseUrl = `http://${upstreamAddress.host}:${upstreamAddress.port}`;

    const upsertCalls = [];
    const refreshCalls = [];

    const app = express();
    app.use(express.json());
    registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, {
      ...createOpenCodeRouteDependencies(),
      buildOpenCodeUrl: (routePath) => `${upstreamBaseUrl}${routePath}`,
      upsertProviderConfig: (providerID, workingDirectory, scope, providerConfig) => {
        upsertCalls.push({ providerID, workingDirectory, scope, providerConfig });
        return { providerId: providerID, scope, path: '/tmp/config.json' };
      },
      refreshOpenCodeAfterConfigChange: async (reason) => {
        refreshCalls.push(reason);
      },
    });

    const authModule = await import('../opencode/auth.js');
    const authFilePath = authModule.AUTH_FILE;
    let backup = null;

    try {
      backup = await fsPromises.readFile(authFilePath, 'utf8');
    } catch {
      backup = null;
    }

    try {
      await fsPromises.mkdir(path.dirname(authFilePath), { recursive: true });
      await fsPromises.writeFile(authFilePath, JSON.stringify({
        litellm: {
          apiKey: 'secret',
          baseURL: 'http://192.168.0.8:4000/v1',
        },
      }), 'utf8');

      const server = http.createServer(app);
      testServers.push(server);
      const address = await listenOnEphemeralPort(server);
      const baseUrl = `http://${address.host}:${address.port}`;

      const response = await fetch(`${baseUrl}/api/config/providers`);
      expect(response.status).toBe(200);
      expect(upsertCalls).toEqual([
        {
          providerID: 'litellm',
          workingDirectory: null,
          scope: 'user',
          providerConfig: {},
        },
      ]);
      expect(refreshCalls).toEqual(['provider litellm config restored from auth']);
    } finally {
      if (backup === null) {
        await fsPromises.rm(authFilePath, { force: true });
      } else {
        await fsPromises.writeFile(authFilePath, backup, 'utf8');
      }
    }
  });

  it('allows canonical provider load for direct repo paths outside registered projects', async () => {
    const upstreamApp = express();
    upstreamApp.get('/config/providers', (_req, res) => {
      res.json({ providers: [], default: {} });
    });

    const upstreamServer = http.createServer(upstreamApp);
    testServers.push(upstreamServer);
    const upstreamAddress = await listenOnEphemeralPort(upstreamServer);
    const upstreamBaseUrl = `http://${upstreamAddress.host}:${upstreamAddress.port}`;

    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, {
      ...createOpenCodeRouteDependencies(),
      buildOpenCodeUrl: (routePath) => `${upstreamBaseUrl}${routePath}`,
      resolveProjectDirectory: async () => ({ directory: null, error: 'Directory not found' }),
    });

    const authModule = await import('../opencode/auth.js');
    const authFilePath = authModule.AUTH_FILE;
    let backup = null;

    try {
      backup = await fsPromises.readFile(authFilePath, 'utf8');
    } catch {
      backup = null;
    }

    try {
      await fsPromises.mkdir(path.dirname(authFilePath), { recursive: true });
      await fsPromises.writeFile(authFilePath, JSON.stringify({
        litellm: {
          apiKey: 'secret',
          baseURL: 'http://192.168.0.8:4000/v1',
        },
      }), 'utf8');

      const server = http.createServer(app);
      testServers.push(server);
      const address = await listenOnEphemeralPort(server);
      const baseUrl = `http://${address.host}:${address.port}`;

      const response = await fetch(`${baseUrl}/api/config/providers?directory=${encodeURIComponent('/opt/openchamber')}`);
      expect(response.status).toBe(200);
      const payload = await response.json();
      const provider = payload.providers.find((entry) => entry.id === 'litellm');
      expect(provider).toBeDefined();
      expect(provider.runtimeManaged).toBe(true);
    } finally {
      if (backup === null) {
        await fsPromises.rm(authFilePath, { force: true });
      } else {
        await fsPromises.writeFile(authFilePath, backup, 'utf8');
      }
    }
  });

  it('classifies auth failures for runtime-managed discovery explicitly', async () => {
    const upstreamApp = express();
    upstreamApp.get('/config/providers', (_req, res) => {
      res.json({ providers: [], default: {} });
    });

    const upstreamServer = http.createServer(upstreamApp);
    testServers.push(upstreamServer);
    const upstreamAddress = await listenOnEphemeralPort(upstreamServer);
    const upstreamBaseUrl = `http://${upstreamAddress.host}:${upstreamAddress.port}`;

    const providerApp = express();
    providerApp.get('/models', (_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
    });

    const providerServer = http.createServer(providerApp);
    testServers.push(providerServer);
    const providerAddress = await listenOnEphemeralPort(providerServer);
    const providerBaseUrl = `http://${providerAddress.host}:${providerAddress.port}`;

    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, {
      ...createOpenCodeRouteDependencies(),
      buildOpenCodeUrl: (routePath) => `${upstreamBaseUrl}${routePath}`,
    });

    const authModule = await import('../opencode/auth.js');
    const authFilePath = authModule.AUTH_FILE;
    let backup = null;

    try {
      backup = await fsPromises.readFile(authFilePath, 'utf8');
    } catch {
      backup = null;
    }

    try {
      await fsPromises.mkdir(path.dirname(authFilePath), { recursive: true });
      await fsPromises.writeFile(authFilePath, JSON.stringify({
        litellm: {
          apiKey: 'wrong-secret',
          baseURL: providerBaseUrl,
        },
      }), 'utf8');

      const server = http.createServer(app);
      testServers.push(server);
      const address = await listenOnEphemeralPort(server);
      const baseUrl = `http://${address.host}:${address.port}`;

      const provider = await waitFor(async () => {
        const response = await fetch(`${baseUrl}/api/config/providers`);
        const payload = await response.json();
        const entry = payload.providers.find((candidate) => candidate.id === 'litellm');
        return entry?.discovery?.state === 'error' ? entry : null;
      });

      expect(provider.discovery).toEqual({
        state: 'error',
        errorType: 'auth',
        message: 'Unauthorized',
      });
      expect(provider.models).toEqual({});
    } finally {
      if (backup === null) {
        await fsPromises.rm(authFilePath, { force: true });
      } else {
        await fsPromises.writeFile(authFilePath, backup, 'utf8');
      }
    }
  });

  it('keeps existing config settings route response shape intact', async () => {
    const baseDirectory = await createTempDirectory();
    const runtimeBackend = createRuntimeBackend({ fsPromises, path, baseDirectory });

    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, createOpenCodeRouteDependencies());
    registerRuntimeRoutes(app, { runtimeBackend });

    const server = http.createServer(app);
    testServers.push(server);
    const address = await listenOnEphemeralPort(server);
    const baseUrl = `http://${address.host}:${address.port}`;

    const response = await fetch(`${baseUrl}/api/config/settings`);
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload).toEqual({ projects: [] });
  });

  it('keeps existing provider auth disconnect route response shape intact', async () => {
    const baseDirectory = await createTempDirectory();
    const runtimeBackend = createRuntimeBackend({ fsPromises, path, baseDirectory });

    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, createOpenCodeRouteDependencies());
    registerRuntimeRoutes(app, { runtimeBackend });

    const server = http.createServer(app);
    testServers.push(server);
    const address = await listenOnEphemeralPort(server);
    const baseUrl = `http://${address.host}:${address.port}`;

    const response = await fetch(`${baseUrl}/api/provider/openai/auth?scope=auth`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload).toEqual({
      success: true,
      removed: false,
      requiresReload: false,
      message: 'Provider was not connected',
    });
  });

  it('reports failed tool executions as failed tasks instead of completed tasks', async () => {
    const baseDirectory = await createTempDirectory();
    const runtimeBackend = createRuntimeBackend({
      fsPromises,
      path,
      baseDirectory,
      providerAdapterOptions: {
        getProviderAuth: () => ({ apiKey: 'test-api-key' }),
        getProviderSources: () => ({ sources: { auth: { exists: true } } }),
        resolveOpenCodeEnvConfig: () => ({ configuredOpenCodeHost: null }),
      },
    });

    const events = [];
    runtimeBackend.subscribeEvents((event) => events.push(event));

    const result = await runtimeBackend.runTask({
      metadata: { scenario: 'failing-tool' },
      toolInvocation: {
        toolName: 'runtime.missing',
        input: {},
        requiresApproval: false,
      },
    });

    expect(result.toolResult.status).toBe('failed');
    expect(result.task.status).toBe('failed');
    expect(events.map((event) => event.type)).toContain('task.failed');
    expect(events.map((event) => event.type)).not.toContain('task.completed');
  });
});
