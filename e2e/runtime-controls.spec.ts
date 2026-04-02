import path from 'node:path';
import { test, expect } from '@playwright/test';

const EVIDENCE_RUNTIME = path.resolve('C:/Users/ccolt/.sisyphus/evidence/task-10-ui-runtime.png');
const EVIDENCE_RUNTIME_ERROR = path.resolve('C:/Users/ccolt/.sisyphus/evidence/task-10-ui-runtime-error.png');

const createModel = (
  id: string,
  name: string,
  capabilities: Partial<{
    toolcall: boolean;
    reasoning: boolean;
    temperature: boolean;
    attachment: boolean;
    input: Partial<{ text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }>;
    output: Partial<{ text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }>;
  }> = {},
) => ({
  id,
  name,
  capabilities: {
    toolcall: false,
    reasoning: false,
    temperature: true,
    attachment: false,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
      ...(capabilities.input ?? {}),
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
      ...(capabilities.output ?? {}),
    },
    ...capabilities,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 128_000,
    output: 4_096,
  },
});

const seedProviders = async (
  page: import('@playwright/test').Page,
  selectedProviderId: 'openai' | 'anthropic' = 'openai',
) => {
  await page.waitForFunction(() => Boolean((window as any).__zustand_config_store__));
  await page.evaluate(
    ({ selectedProviderIdOnPage, providers }) => {
      const store = (window as any).__zustand_config_store__;

      store.setState(
        {
          providers,
          selectedProviderId: selectedProviderIdOnPage,
          runtimeControlsEnabled: true,
          runtimeRequireTools: true,
          runtimeRequireStructuredOutput: false,
          runtimeRequireStreaming: false,
        },
        false,
      );
    },
    {
      selectedProviderIdOnPage: selectedProviderId,
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          models: [
            createModel('gpt-4.1', 'GPT-4.1', {
              toolcall: true,
              reasoning: true,
              attachment: true,
            }),
          ],
        },
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: [
            createModel('claude-3', 'Claude 3', {
              reasoning: true,
            }),
          ],
        },
      ],
    },
  );
};

const stubProviderEndpoints = async (page: import('@playwright/test').Page) => {
  await page.route('**/api/provider/auth', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.route('**/api/config/providers**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providers: [
          {
            id: 'openai',
            name: 'OpenAI',
            models: {
              'gpt-4.1': createModel('gpt-4.1', 'GPT-4.1', {
                toolcall: true,
                reasoning: true,
                attachment: true,
              }),
            },
          },
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: {
              'claude-3': createModel('claude-3', 'Claude 3', {
                reasoning: true,
              }),
            },
          },
        ],
        default: {
          openai: 'gpt-4.1',
          anthropic: 'claude-3',
        },
      }),
    });
  });

  await page.route('**/api/provider', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        all: [
          { id: 'openai', name: 'OpenAI' },
          { id: 'anthropic', name: 'Anthropic' },
        ],
      }),
    });
  });

  await page.route(/\/api\/provider\/[^/]+\/source(\?.*)?$/i, async (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/\/api\/provider\/([^/]+)\/source/i);
    const providerId = match?.[1] ?? 'unknown';

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providerId,
        sources: {
          auth: { exists: false },
          user: { exists: false, path: null },
          project: { exists: false, path: null },
          custom: { exists: false, path: null },
        },
      }),
    });
  });

  await page.route('**/api/git/**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }

    const url = new URL(route.request().url());
    const pathname = url.pathname;

    let body: unknown;
    if (pathname.endsWith('/check')) {
      body = { isGitRepository: false };
    } else if (pathname.endsWith('/status')) {
      body = { isGitRepository: false, files: [], branch: null, ahead: 0, behind: 0 };
    } else if (pathname.endsWith('/worktree-type')) {
      body = { linked: false };
    } else if (pathname.endsWith('/has-local-identity')) {
      body = { hasLocalIdentity: false };
    } else if (pathname.endsWith('/identities')) {
      body = [];
    } else if (pathname.endsWith('/discover-credentials')) {
      body = [];
    } else if (pathname.endsWith('/remote-url')) {
      body = { url: null };
    } else if (pathname.endsWith('/current-identity')) {
      body = null;
    } else {
      body = {};
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.route('**/api/opencode/runtime/create-session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session: {
          sessionID: 'runtime-session-1',
          runtimeID: 'runtime-1',
          status: 'idle',
          createdAt: '2026-04-02T00:00:00.000Z',
          updatedAt: '2026-04-02T00:00:00.000Z',
          metadata: {},
        },
      }),
    });
  });

  await page.route('**/api/opencode/runtime/provider-negotiate', async (route) => {
    const raw = route.request().postData() || '{}';
    const payload = JSON.parse(raw) as { providerID?: string };
    const isOpenAi = payload.providerID === 'openai';

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        isOpenAi
          ? {
              outcome: 'accept',
              providerID: 'openai',
              missingCapabilities: [],
              degradedCapabilities: [],
              reason: null,
            }
          : {
              outcome: 'refuse',
              providerID: 'anthropic',
              missingCapabilities: ['tools'],
              degradedCapabilities: [],
              reason: 'Tool support is required.',
            },
      ),
    });
  });

  await page.route('**/api/opencode/runtime/run-task', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task: {
          taskID: 'task-1',
          runtimeID: 'runtime-1',
          status: 'running',
          createdAt: '2026-04-02T00:00:01.000Z',
          updatedAt: '2026-04-02T00:00:02.000Z',
          startedAt: '2026-04-02T00:00:02.000Z',
          finishedAt: null,
          metadata: { source: 'playwright' },
        },
        negotiation: {
          outcome: 'accept',
          providerID: 'openai',
          missingCapabilities: [],
          degradedCapabilities: [],
          reason: null,
        },
      }),
    });
  });

  await page.route('**/api/opencode/runtime/cancel-task', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task: {
          taskID: 'task-1',
          runtimeID: 'runtime-1',
          status: 'cancelled',
          createdAt: '2026-04-02T00:00:01.000Z',
          updatedAt: '2026-04-02T00:00:03.000Z',
          startedAt: '2026-04-02T00:00:02.000Z',
          finishedAt: '2026-04-02T00:00:03.000Z',
          metadata: { source: 'playwright' },
        },
      }),
    });
  });

  await page.route('**/api/opencode/runtime/subscribe-events', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
      body:
        'data: {"type":"task.enqueued","properties":{"runtimeID":"runtime-1","taskID":"task-1","providerID":"openai","occurredAt":"2026-04-02T00:00:01.000Z","payload":{"eventSequence":1}}}\n\n' +
        'data: {"type":"task.started","properties":{"runtimeID":"runtime-1","taskID":"task-1","providerID":"openai","occurredAt":"2026-04-02T00:00:02.000Z","payload":{"eventSequence":2}}}\n\n',
    });
  });
};

test('shows runtime status, runs task, renders events', async ({ page }) => {
  await stubProviderEndpoints(page);
  await page.goto('/?settings=providers');

  await seedProviders(page);

  await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'OpenAI' })).toBeVisible();

  const runtime = page.getByTestId('runtime-controls');
  await expect(runtime).toBeVisible();

  await runtime.getByRole('button', { name: 'Run task' }).click();

  await expect(runtime).toContainText(/Latest event:/);
  await expect(runtime).toContainText(/Latest task:/);

  await page.screenshot({ path: EVIDENCE_RUNTIME, fullPage: true });
});

test('shows capability warnings and blocks unsupported actions', async ({ page }) => {
  await stubProviderEndpoints(page);
  await page.goto('/?settings=providers');

  await seedProviders(page, 'anthropic');

  await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
  await page.getByText('Anthropic', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Anthropic' })).toBeVisible();

  const runtime = page.getByTestId('runtime-controls');
  await expect(runtime).toBeVisible();
  await expect(runtime).toContainText('Provider cannot satisfy required capabilities');
  await expect(runtime.getByRole('button', { name: 'Run task' })).toBeDisabled();
  await expect(runtime).toContainText('Missing');

  await page.screenshot({ path: EVIDENCE_RUNTIME_ERROR, fullPage: true });
});
