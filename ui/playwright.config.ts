import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  // The scroll test only fails on the CI runner; the trace is what shows what the page did there.
  projects: [{ name: "chromium", use: { browserName: "chromium", trace: "retain-on-failure" } }],
});
