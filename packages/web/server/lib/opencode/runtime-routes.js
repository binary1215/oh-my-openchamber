const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const normalizeCategory = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'evidence' || normalized === 'plans' || normalized === 'handoffs') {
    return normalized;
  }

  return null;
};

const writeRuntimeSseEvent = (res, event) => {
  res.write(
    `data: ${JSON.stringify({
      type: event.type,
      properties: {
        runtimeID: event.runtimeID,
        taskID: event.taskID ?? null,
        providerID: event.providerID ?? null,
        occurredAt: event.occurredAt,
        payload: event.payload ?? {},
      },
    })}\n\n`,
  );
};

export const registerRuntimeRoutes = (app, dependencies) => {
  const { runtimeBackend } = dependencies;

  if (!runtimeBackend) {
    throw new Error('registerRuntimeRoutes requires runtimeBackend');
  }

  app.post('/api/opencode/runtime/create-session', (req, res) => {
    try {
      const body = asObject(req.body);
      const session = runtimeBackend.createSession({ metadata: asObject(body.metadata) });
      res.json(session);
    } catch (error) {
      res.status(500).json({ error: error.message || 'Failed to create runtime session' });
    }
  });

  app.post('/api/opencode/runtime/run-task', async (req, res) => {
    try {
      const body = asObject(req.body);
      const result = await runtimeBackend.runTask({
        metadata: asObject(body.metadata),
        providerID: typeof body.providerID === 'string' ? body.providerID : undefined,
        requiredCapabilities: body.requiredCapabilities,
        degradableCapabilities: body.degradableCapabilities,
        toolInvocation:
          body.toolInvocation && typeof body.toolInvocation === 'object' && !Array.isArray(body.toolInvocation)
            ? body.toolInvocation
            : null,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message || 'Failed to run task' });
    }
  });

  app.post('/api/opencode/runtime/cancel-task', (req, res) => {
    try {
      const body = asObject(req.body);
      const taskID = typeof body.taskID === 'string' ? body.taskID.trim() : '';
      if (!taskID) {
        return res.status(400).json({ error: 'taskID is required' });
      }

      const reason = typeof body.reason === 'string' && body.reason.trim().length > 0 ? body.reason.trim() : 'cancelled';
      const task = runtimeBackend.cancelTask(taskID, reason);
      return res.json({ task });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to cancel task' });
    }
  });

  app.post('/api/opencode/runtime/provider-negotiate', (req, res) => {
    try {
      const body = asObject(req.body);
      const providerID = typeof body.providerID === 'string' ? body.providerID.trim() : '';
      if (!providerID) {
        return res.status(400).json({ error: 'providerID is required' });
      }

      const negotiation = runtimeBackend.negotiateProvider({
        providerID,
        requiredCapabilities: body.requiredCapabilities,
        degradableCapabilities: body.degradableCapabilities,
      });

      return res.json(negotiation);
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to negotiate provider capabilities' });
    }
  });

  app.get('/api/opencode/runtime/subscribe-events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const unsubscribe = runtimeBackend.subscribeEvents((event) => {
      writeRuntimeSseEvent(res, event);
    });

    req.on('close', () => {
      unsubscribe();
      if (!res.writableEnded) {
        res.end();
      }
    });
  });

  app.get('/api/opencode/runtime/artifacts/:category/:fileName', async (req, res) => {
    try {
      const category = normalizeCategory(req.params.category);
      if (!category) {
        return res.status(400).json({ error: 'Unsupported artifact category' });
      }

      const fileName = typeof req.params.fileName === 'string' ? req.params.fileName : '';
      if (!fileName) {
        return res.status(400).json({ error: 'fileName is required' });
      }

      const content = await runtimeBackend.readArtifact(category, fileName);
      return res.json({
        category,
        fileName,
        content,
      });
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return res.status(404).json({ error: 'Artifact not found' });
      }

      return res.status(500).json({ error: error.message || 'Failed to read runtime artifact' });
    }
  });
};
