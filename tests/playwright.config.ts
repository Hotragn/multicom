import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "multicom.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
  outputDir: "../test-results",
});
