import { resolve } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: resolve("wrangler.jsonc") },
    miniflare: {
      bindings: {
        // Keep local .dev.vars from changing the origin used by security fixtures.
        APP_ORIGIN: "https://baghharu.neerrn.com",
        TEST_MIGRATIONS: await readD1Migrations(resolve("migrations")),
        MEDIA_URL_SECRET: "test-only-media-capability-key-32-bytes-minimum",
        GOOGLE_CLIENT_ID: "test-google-client.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "test-google-client-secret",
        META_ACCESS_TOKEN: "test-only-instagram-token",
        META_IG_USER_ID: "17840000000000000",
        R2_ACCOUNT_ID: "test-only-account",
        R2_ACCESS_KEY_ID: "test-only-key",
        R2_SECRET_ACCESS_KEY: "test-only-secret",
      },
      queueConsumers: [],
    },
  }))],
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    maxWorkers: 1,
  },
});
