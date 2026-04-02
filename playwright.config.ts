import { defineConfig } from '@playwright/test';

const port = Number(process.env.OPENCHAMBER_E2E_PORT ?? 3001);
const baseURL = process.env.OPENCHAMBER_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const isWindows = process.platform === 'win32';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL,
    viewport: { width: 1200, height: 820 },
    trace: 'retain-on-failure',
    // On Windows, prefer the system Edge channel to avoid
    // issues with the Playwright-managed Chromium headless shell.
    ...(isWindows ? { channel: 'msedge' } : {}),
  },
  webServer: {
    // Run server from repo root so .git is available for simple-git,
    // but execute the web server entrypoint inside packages/web.
    command: `bun packages/web/server/index.js --port ${port}`,
    cwd: '.',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
