import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: '../../docs/testbericht/e2e-ergebnis.json' }]],
  use: { baseURL: process.env.WEB_URL ?? 'http://localhost:3000', locale: 'de-DE', timezoneId: 'Europe/Berlin', trace: 'off' },
});
