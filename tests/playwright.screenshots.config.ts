import { defineConfig } from "@playwright/test";

// Separate from playwright.config.ts so `npm test` stays a pure quality gate.
export default defineConfig({
  testDir: ".",
  testMatch: "screenshots.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    browserName: "chromium",
    headless: true,
    deviceScaleFactor: 2,
  },
  outputDir: "../test-results",
});
