import { invalidateProviderDiscovery, resolveRuntimeManagedDiscovery } from './provider-discovery.js';
import { RUNTIME_MANAGED_PROVIDERS } from './providers.js';

export const registerOpenCodeRoutes = (app, dependencies) => {
  const {
    crypto,
    clientReloadDelayMs,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    getOpenCodeResolutionSnapshot,
    formatSettingsResponse,
    readSettingsFromDisk,
    readSettingsFromDiskMigrated,
    persistSettings,
    sanitizeProjects,
    validateDirectoryPath,
    resolveProjectDirectory,
    getProviderSources,
    removeProviderConfig,
    upsertProviderConfig,
    refreshOpenCodeAfterConfigChange,
  } = dependencies;

  const runtimeManagedProviderCatalog = Object.freeze(
    Object.fromEntries(
      Object.values(RUNTIME_MANAGED_PROVIDERS).map((provider) => [
        provider.id,
        Object.freeze({
          ...provider,
          runtimeManaged: true,
          authMethods: Object.freeze([
            Object.freeze({ type: 'api', label: 'Manually enter endpoint and API Key' }),
          ]),
        }),
      ]),
    ),
  );
  const runtimeManagedConfigHydration = new Map();

  const normalizeProviderId = (entry) =>
    entry && typeof entry === 'object' ? entry.id || entry.providerID || entry.providerId : null;

  const createProviderModelsRecord = (provider) => {
    if (!provider || typeof provider !== 'object' || !provider.models || typeof provider.models !== 'object') {
      return Object.create(null);
    }

    const models = Object.create(null);
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!modelId || !model || typeof model !== 'object') {
        continue;
      }

      models[modelId] = {
        ...model,
        id: typeof model.id === 'string' && model.id ? model.id : modelId,
        name: typeof model.name === 'string' && model.name ? model.name : modelId,
      };
    }

    return models;
  };

  const createDiscoveryMetadata = ({ state, errorType = null, message = null }) => ({
    state,
    errorType,
    message,
  });

  const inferDiscoveryMetadataFromModels = (provider) => {
    const models = createProviderModelsRecord(provider);
    return {
      models,
      discovery: createDiscoveryMetadata({
        state: Object.keys(models).length > 0 ? 'ready' : 'empty',
      }),
    };
  };

  const buildCanonicalProvidersPayload = async (req) => {
    const upstreamPayload = await fetchUpstreamJson('/config/providers');
    const upstreamProviders = Array.isArray(upstreamPayload?.providers) ? upstreamPayload.providers : [];
    const upstreamDefaults = upstreamPayload?.default && typeof upstreamPayload.default === 'object'
      ? upstreamPayload.default
      : {};

    const providerMap = new Map(
      upstreamProviders
        .filter((provider) => provider && typeof provider === 'object')
        .map((provider) => [normalizeProviderId(provider), provider])
        .filter(([providerId]) => Boolean(providerId)),
    );

    for (const provider of Object.values(runtimeManagedProviderCatalog)) {
      const connectionState = await resolveProviderConnectionState(provider.id, req);
      await ensureRuntimeManagedProviderConfig(provider.id, connectionState);
      const existingProvider = providerMap.get(provider.id);
      const baseProvider = existingProvider && typeof existingProvider === 'object'
        ? { ...existingProvider }
        : {
            id: provider.id,
            name: provider.name,
            models: Object.create(null),
          };

      if (!connectionState.connected && !existingProvider) {
        continue;
      }

      const discovery = resolveRuntimeManagedDiscovery({
        providerId: provider.id,
        directory: connectionState.directory,
        auth: connectionState.auth,
        sources: connectionState.sources,
      });

      providerMap.set(provider.id, {
        ...baseProvider,
        id: provider.id,
        name: baseProvider.name || provider.name,
        runtimeManaged: true,
        connectMode: provider.connectMode,
        supportsBaseUrl: provider.supportsBaseUrl === true,
        models: discovery.models,
        discovery: createDiscoveryMetadata(discovery),
      });
    }

    const providers = Array.from(providerMap.values()).map((provider) => {
      if (provider?.runtimeManaged === true) {
        return provider;
      }

      const normalized = inferDiscoveryMetadataFromModels(provider);
      return {
        ...provider,
        models: normalized.models,
        discovery: normalized.discovery,
      };
    });

    return {
      providers,
      default: upstreamDefaults,
    };
  };

  const fetchUpstreamJson = async (path) => {
    try {
      const response = await fetch(buildOpenCodeUrl(path), {
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
      });

      if (!response.ok) {
        return null;
      }

      return await response.json().catch(() => null);
    } catch {
      return null;
    }
  };

  const resolveProviderConnectionState = async (providerId, req, options = {}) => {
    const tolerateMissingDirectory = options.tolerateMissingDirectory === true;
    const requestedDirectory =
      (typeof req.get === 'function' ? req.get('x-opencode-directory') : null) ||
      (Array.isArray(req.query?.directory) ? req.query.directory[0] : req.query?.directory) ||
      null;

    let directory = null;
    const resolved = await resolveProjectDirectory(req);
    if (resolved.directory) {
      directory = resolved.directory;
    } else if (requestedDirectory) {
      if (tolerateMissingDirectory) {
        directory = requestedDirectory;
      } else {
        directory = requestedDirectory;
      }
    }

    const sources = getProviderSources(providerId, directory).sources;
    const { getProviderAuth } = await getAuthLibrary();
    const auth = getProviderAuth(providerId);
    const authExists = Boolean(auth);
    sources.auth.exists = authExists;

    return {
      directory,
      auth,
      sources,
      connected: authExists || Boolean(sources.user?.exists || sources.project?.exists || sources.custom?.exists),
    };
  };

  const ensureRuntimeManagedProviderConfig = async (providerId, connectionState, options = {}) => {
    const provider = runtimeManagedProviderCatalog[providerId];
    if (!provider || !connectionState?.auth) {
      return false;
    }

    const force = options.force === true;
    const { sources, auth } = connectionState;
    const hasConfigSource = Boolean(sources.user?.exists || sources.project?.exists || sources.custom?.exists);
    if (!force && hasConfigSource) {
      return false;
    }

    if (runtimeManagedConfigHydration.has(providerId)) {
      await runtimeManagedConfigHydration.get(providerId);
      return true;
    }

    const hydrationPromise = (async () => {
      upsertProviderConfig(providerId, null, 'user', {
        ...provider.defaultConfig,
      });

      if (sources.user) {
        sources.user.exists = true;
      }

      await refreshOpenCodeAfterConfigChange(`provider ${providerId} config restored from auth`);
    })();

    runtimeManagedConfigHydration.set(providerId, hydrationPromise);
    try {
      await hydrationPromise;
      return true;
    } finally {
      runtimeManagedConfigHydration.delete(providerId);
    }
  };

  const buildForwardHeaders = (req) => {
    const headers = {
      Accept: req.get?.('accept') || 'application/json',
      ...getOpenCodeAuthHeaders(),
    };

    const contentType = req.get?.('content-type');
    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    return headers;
  };

  const readPromptRequestBody = async (req) => {
    if (req.body && typeof req.body === 'object') {
      return req.body;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
      return {};
    }

    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
      return {};
    }

    return JSON.parse(raw);
  };

  app.get('/api/config/providers', async (req, res) => {
    try {
      return res.json(await buildCanonicalProvidersPayload(req));
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to load canonical providers' });
    }
  });

  app.post('/api/session/:sessionId/prompt_async', async (req, res, next) => {
    try {
      const parsedBody = req.body
        && typeof req.body === 'object'
        && Object.keys(req.body).length > 0
          ? req.body
          : null;
      const parsedProviderId = typeof parsedBody?.model?.providerID === 'string' ? parsedBody.model.providerID : null;
      if (!parsedProviderId || !runtimeManagedProviderCatalog[parsedProviderId]) {
        return next();
      }

      const requestBody = parsedBody ?? await readPromptRequestBody(req);
      const providerId = typeof requestBody?.model?.providerID === 'string' ? requestBody.model.providerID : null;
      if (providerId && runtimeManagedProviderCatalog[providerId]) {
        const connectionState = await resolveProviderConnectionState(providerId, req, {
          tolerateMissingDirectory: true,
        });
        await ensureRuntimeManagedProviderConfig(providerId, connectionState, { force: true });
      }

      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      const upstreamResponse = await fetch(buildOpenCodeUrl(`/session/${req.params.sessionId}/prompt_async${query}`), {
        method: 'POST',
        headers: buildForwardHeaders(req),
        body: JSON.stringify(requestBody),
      });

      res.status(upstreamResponse.status);
      const contentType = upstreamResponse.headers.get('content-type');
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }

      const responseText = await upstreamResponse.text();
      return res.send(responseText);
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/provider', async (req, res) => {
    try {
      const upstreamPayload = await fetchUpstreamJson('/provider');
      const upstreamEntries = Array.isArray(upstreamPayload?.all)
        ? upstreamPayload.all
        : Array.isArray(upstreamPayload?.providers)
          ? upstreamPayload.providers
          : Array.isArray(upstreamPayload)
            ? upstreamPayload
            : [];

      const merged = [...upstreamEntries];
      const existingIds = new Set(
        upstreamEntries
          .map((entry) => (entry && typeof entry === 'object' ? entry.id || entry.providerID || entry.providerId : null))
          .filter(Boolean),
      );

      const canonicalPayload = await buildCanonicalProvidersPayload(req);
      const canonicalById = new Map(
        canonicalPayload.providers
          .map((provider) => [provider?.id, provider])
          .filter(([providerId]) => Boolean(providerId)),
      );

      for (const provider of Object.values(runtimeManagedProviderCatalog)) {
        const connectionState = await resolveProviderConnectionState(provider.id, req);
        if (!existingIds.has(provider.id)) {
          const canonicalProvider = canonicalById.get(provider.id);
          merged.push({
            id: provider.id,
            name: provider.name,
            runtimeManaged: true,
            connectMode: provider.connectMode,
            supportsBaseUrl: provider.supportsBaseUrl === true,
            connected: connectionState.connected,
            discovery: canonicalProvider?.discovery,
          });
        }
      }

      return res.json({ all: merged });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to load providers' });
    }
  });

  app.get('/api/provider/auth', async (_req, res) => {
    try {
      const upstreamPayload = await fetchUpstreamJson('/provider/auth');
      const upstreamAuth = upstreamPayload && typeof upstreamPayload === 'object' ? upstreamPayload : {};

      for (const provider of Object.values(runtimeManagedProviderCatalog)) {
        if (!Array.isArray(upstreamAuth[provider.id])) {
          upstreamAuth[provider.id] = [...provider.authMethods];
        }
      }

      return res.json(upstreamAuth);
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to load provider auth methods' });
    }
  });

  app.put('/api/provider/:providerId/connect', async (req, res) => {
    try {
      const { providerId } = req.params;
      const provider = runtimeManagedProviderCatalog[providerId];
      if (!provider) {
        return res.status(404).json({ error: 'Unsupported provider' });
      }

      const scope = typeof req.body?.scope === 'string' ? req.body.scope : 'user';
      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;

      let directory = null;
      if (scope === 'project' || requestedDirectory) {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({ error: resolved.error });
        }
        directory = resolved.directory;
      }

      const result = upsertProviderConfig(providerId, directory, scope, provider.defaultConfig);
      invalidateProviderDiscovery(providerId);
      await refreshOpenCodeAfterConfigChange(`provider ${providerId} connected (${scope})`);

      return res.json({
        success: true,
        providerId,
        connected: true,
        requiresReload: true,
        reloadDelayMs: clientReloadDelayMs,
        config: result,
      });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to connect provider' });
    }
  });

  let authLibrary = null;
  const getAuthLibrary = async () => {
    if (!authLibrary) {
      authLibrary = await import('./auth.js');
    }
    return authLibrary;
  };

  app.put('/api/auth/:providerId', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const { upsertProviderAuth } = await getAuthLibrary();
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const type = typeof body.type === 'string' ? body.type : 'api';
      const apiKey = typeof body.key === 'string' ? body.key.trim() : '';
      const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : '';

      if (type !== 'api') {
        return res.status(400).json({ error: 'Unsupported auth type' });
      }

      if (!apiKey && !baseURL) {
        return res.status(400).json({ error: 'API key or base URL is required' });
      }

      const nextAuth = {};
      if (apiKey) nextAuth.apiKey = apiKey;
      if (baseURL) nextAuth.baseURL = baseURL;

      const runtimeManagedProvider = runtimeManagedProviderCatalog[providerId];
      if (runtimeManagedProvider) {
        upsertProviderConfig(providerId, null, 'user', {
          ...runtimeManagedProvider.defaultConfig,
        });
      }

      const saved = upsertProviderAuth(providerId, nextAuth);
      invalidateProviderDiscovery(providerId);
      await refreshOpenCodeAfterConfigChange(`provider ${providerId} auth saved`);

      return res.json({
        success: true,
        providerId,
        auth: saved,
        requiresReload: true,
        reloadDelayMs: clientReloadDelayMs,
      });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to save provider auth' });
    }
  });

  app.get('/api/config/settings', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      res.json(formatSettingsResponse(settings));
    } catch (error) {
      console.error('Failed to read settings:', error);
      res.status(500).json({ error: 'Failed to read settings' });
    }
  });

  app.get('/api/config/opencode-resolution', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      const resolution = await getOpenCodeResolutionSnapshot(settings);
      res.json(resolution);
    } catch (error) {
      console.error('Failed to resolve OpenCode binary:', error);
      res.status(500).json({ error: 'Failed to resolve OpenCode binary' });
    }
  });

  app.put('/api/config/settings', async (req, res) => {
    console.log('[API:PUT /api/config/settings] Received request');
    try {
      const updated = await persistSettings(req.body ?? {});
      console.log(`[API:PUT /api/config/settings] Success, returning ${updated.projects?.length || 0} projects`);
      res.json(updated);
    } catch (error) {
      console.error('[API:PUT /api/config/settings] Failed to save settings:', error);
      console.error('[API:PUT /api/config/settings] Error stack:', error.stack);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  app.get('/api/provider/:providerId/source', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;

      let directory = null;
      const resolved = await resolveProjectDirectory(req);
      if (resolved.directory) {
        directory = resolved.directory;
      } else if (requestedDirectory) {
        return res.status(400).json({ error: resolved.error });
      }

      const sources = getProviderSources(providerId, directory);
      const { getProviderAuth } = await getAuthLibrary();
      const auth = getProviderAuth(providerId);
      sources.sources.auth.exists = Boolean(auth);

      return res.json({
        providerId,
        sources: sources.sources,
      });
    } catch (error) {
      console.error('Failed to get provider sources:', error);
      return res.status(500).json({ error: error.message || 'Failed to get provider sources' });
    }
  });

  app.delete('/api/provider/:providerId/auth', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const scope = typeof req.query?.scope === 'string' ? req.query.scope : 'auth';
      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;
      let directory = null;

      if (scope === 'project' || requestedDirectory) {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({ error: resolved.error });
        }
        directory = resolved.directory;
      } else {
        const resolved = await resolveProjectDirectory(req);
        if (resolved.directory) {
          directory = resolved.directory;
        }
      }

      let removed = false;
      if (scope === 'auth') {
        const { removeProviderAuth } = await getAuthLibrary();
        removed = removeProviderAuth(providerId);
      } else if (scope === 'user' || scope === 'project' || scope === 'custom') {
        removed = removeProviderConfig(providerId, directory, scope);
      } else if (scope === 'all') {
        const { removeProviderAuth } = await getAuthLibrary();
        const authRemoved = removeProviderAuth(providerId);
        const userRemoved = removeProviderConfig(providerId, directory, 'user');
        const projectRemoved = directory ? removeProviderConfig(providerId, directory, 'project') : false;
        const customRemoved = removeProviderConfig(providerId, directory, 'custom');
        removed = authRemoved || userRemoved || projectRemoved || customRemoved;
      } else {
        return res.status(400).json({ error: 'Invalid scope' });
      }

      if (removed) {
        invalidateProviderDiscovery(providerId);
        await refreshOpenCodeAfterConfigChange(`provider ${providerId} disconnected (${scope})`);
      }

      return res.json({
        success: true,
        removed,
        requiresReload: removed,
        message: removed ? 'Provider disconnected successfully' : 'Provider was not connected',
        reloadDelayMs: removed ? clientReloadDelayMs : undefined,
      });
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      return res.status(500).json({ error: error.message || 'Failed to disconnect provider' });
    }
  });

  app.post('/api/opencode/directory', async (req, res) => {
    try {
      const requestedPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
      }

      const validated = await validateDirectoryPath(requestedPath);
      if (!validated.ok) {
        return res.status(400).json({ error: validated.error });
      }

      const resolvedPath = validated.directory;
      const currentSettings = await readSettingsFromDisk();
      const existingProjects = sanitizeProjects(currentSettings.projects) || [];
      const existing = existingProjects.find((project) => project.path === resolvedPath) || null;

      const nextProjects = existing
        ? existingProjects
        : [
            ...existingProjects,
            {
              id: crypto.randomUUID(),
              path: resolvedPath,
              addedAt: Date.now(),
              lastOpenedAt: Date.now(),
            },
          ];

      const activeProjectId = existing ? existing.id : nextProjects[nextProjects.length - 1].id;

      const updated = await persistSettings({
        projects: nextProjects,
        activeProjectId,
        lastDirectory: resolvedPath,
      });

      return res.json({
        success: true,
        restarted: false,
        path: resolvedPath,
        settings: updated,
      });
    } catch (error) {
      console.error('Failed to update OpenCode working directory:', error);
      return res.status(500).json({ error: error.message || 'Failed to update working directory' });
    }
  });
};
