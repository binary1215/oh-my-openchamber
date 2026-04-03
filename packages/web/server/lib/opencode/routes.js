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

  const RUNTIME_MANAGED_PROVIDERS = Object.freeze({
    ollama: Object.freeze({
      id: 'ollama',
      name: 'Ollama',
      runtimeManaged: true,
      connectMode: 'api',
      supportsBaseUrl: true,
      authMethods: Object.freeze([
        Object.freeze({ type: 'api', label: 'Manually enter endpoint and API Key' }),
      ]),
    }),
    litellm: Object.freeze({
      id: 'litellm',
      name: 'LiteLLM',
      runtimeManaged: true,
      connectMode: 'api',
      supportsBaseUrl: true,
      authMethods: Object.freeze([
        Object.freeze({ type: 'api', label: 'Manually enter endpoint and API Key' }),
      ]),
    }),
  });

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

  const resolveProviderConnectionState = async (providerId, req) => {
    const requestedDirectory =
      (typeof req.get === 'function' ? req.get('x-opencode-directory') : null) ||
      (Array.isArray(req.query?.directory) ? req.query.directory[0] : req.query?.directory) ||
      null;

    let directory = null;
    const resolved = await resolveProjectDirectory(req);
    if (resolved.directory) {
      directory = resolved.directory;
    } else if (requestedDirectory) {
      throw new Error(resolved.error);
    }

    const sources = getProviderSources(providerId, directory).sources;
    const { getProviderAuth } = await getAuthLibrary();
    const auth = getProviderAuth(providerId);
    const authExists = Boolean(auth);
    sources.auth.exists = authExists;

    return {
      sources,
      connected: authExists || Boolean(sources.user?.exists || sources.project?.exists || sources.custom?.exists),
    };
  };

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

      for (const provider of Object.values(RUNTIME_MANAGED_PROVIDERS)) {
        const connectionState = await resolveProviderConnectionState(provider.id, req);
        if (!existingIds.has(provider.id)) {
          merged.push({
            id: provider.id,
            name: provider.name,
            runtimeManaged: true,
            connectMode: provider.connectMode,
            supportsBaseUrl: provider.supportsBaseUrl === true,
            connected: connectionState.connected,
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

      for (const provider of Object.values(RUNTIME_MANAGED_PROVIDERS)) {
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
      const provider = RUNTIME_MANAGED_PROVIDERS[providerId];
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

      if (RUNTIME_MANAGED_PROVIDERS[providerId]) {
        try {
          removeProviderConfig(providerId, null, 'user');
        } catch {
          // ignore cleanup failure and continue with auth save
        }
        try {
          removeProviderConfig(providerId, null, 'custom');
        } catch {
          // ignore cleanup failure and continue with auth save
        }
      }

      const saved = upsertProviderAuth(providerId, nextAuth);
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
