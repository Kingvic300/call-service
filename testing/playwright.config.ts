import { defineConfig } from '@playwright/test';

const BROWSER_APP_PORT = Number(process.env.BROWSER_APP_PORT ?? 8899);

export default defineConfig({
  testDir: './scenarios',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // scenarios share meetings/rooms; run sequentially for determinism
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'reports/results.json' }],
    ['junit', { outputFile: 'reports/junit.xml' }],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--no-sandbox',
            '--disable-dev-shm-usage',
          ],
        },
      },
    },
  ],
  webServer: {
    command: `node static-server.mjs ${BROWSER_APP_PORT}`,
    url: `http://localhost:${BROWSER_APP_PORT}/health`,
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
