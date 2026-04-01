import { defineConfig } from '@playwright/test';

const port = Number(process.env.OPENCHAMBER_E2E_PORT ?? 3001);
const baseURL = process.env.OPENCHAMBER_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

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
  },
  webServer: {
    command: `bun server/index.js --port ${port}`,
    cwd: './packages/web',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
