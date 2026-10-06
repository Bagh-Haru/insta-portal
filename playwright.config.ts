import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", timeout: 180_000, expect: { timeout: 10_000 }, workers: 1,
  use: { baseURL: "http://127.0.0.1:8789", viewport: { width: 390, height: 844 }, launchOptions: { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "node scripts/e2e-server.mjs", url: "http://127.0.0.1:8789", reuseExistingServer: false },
});
