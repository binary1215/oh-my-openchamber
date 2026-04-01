import { test, expect } from '@playwright/test';

const EVIDENCE_RUNTIME = 'C:\\Users\\ccolt\\.sisyphus\\evidence\\task-10-ui-runtime.png';
const EVIDENCE_RUNTIME_ERROR = 'C:\\Users\\ccolt\\.sisyphus\\evidence\\task-10-ui-runtime-error.png';

const seedProviders = async (page: import('@playwright/test').Page) => {
  await page.waitForFunction(() => Boolean((window as any).__zustand_config_store__));
  await page.evaluate(() => {
    const store = (window as any).__zustand_config_store__;

    store.setState(
      {
        providers: [
          {
            id: 'openai',
            name: 'OpenAI',
            models: [{ id: 'gpt-4.1', name: 'GPT-4.1' }],
          },
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: [{ id: 'claude-3', name: 'Claude 3' }],
          },
        ],
        selectedProviderId: 'openai',
        runtimeControlsEnabled: true,
        runtimeRequireTools: true,
        runtimeRequireStructuredOutput: false,
        runtimeRequireStreaming: false,
      },
      false
    );
  });
};

const stubProviderEndpoints = async (page: import('@playwright/test').Page) => {
  await page.route('**/api/provider/auth', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
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
};

test('shows runtime status, runs task, renders events', async ({ page }) => {
  await stubProviderEndpoints(page);
  await page.goto('/');

  await seedProviders(page);

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  await page.getByRole('button', { name: /providers/i }).first().click();
  await expect(page.getByRole('heading', { name: /openai/i })).toBeVisible();

  const runtime = page.getByTestId('runtime-controls');
  await expect(runtime).toBeVisible();

  await runtime.getByRole('button', { name: 'Run task' }).click();

  await expect(runtime).toContainText(/Latest event:/);
  await expect(runtime).toContainText(/Latest task:/);

  await page.screenshot({ path: EVIDENCE_RUNTIME, fullPage: true });
});

test('shows capability warnings and blocks unsupported actions', async ({ page }) => {
  await stubProviderEndpoints(page);
  await page.goto('/');

  await seedProviders(page);

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: /providers/i }).first().click();

  await page.getByRole('button', { name: /anthropic/i }).click();
  await expect(page.getByRole('heading', { name: /anthropic/i })).toBeVisible();

  const runtime = page.getByTestId('runtime-controls');
  await expect(runtime).toBeVisible();
  await expect(runtime).toContainText('Provider cannot satisfy required capabilities');
  await expect(runtime.getByRole('button', { name: 'Run task' })).toBeDisabled();
  await expect(runtime).toContainText('Missing');

  await page.screenshot({ path: EVIDENCE_RUNTIME_ERROR, fullPage: true });
});
