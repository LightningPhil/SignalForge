import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT || 4173);
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const webServerCommand = process.env.PLAYWRIGHT_SKIP_BUILD
  ? `npm run preview -- --host 127.0.0.1 --port ${port}`
  : `npm run build && npm run preview -- --host 127.0.0.1 --port ${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : 'list',
  use: {
    baseURL: externalBaseUrl || `http://127.0.0.1:${port}/SignalForge/`,
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: webServerCommand,
        reuseExistingServer: false,
        timeout: 180_000,
        url: `http://127.0.0.1:${port}/SignalForge/`
      }
});
