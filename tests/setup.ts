import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach } from "vitest";
import type { D1Migration } from "cloudflare:test";
import type { Env } from "../worker/types";

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM audit_log"),
    testEnv.DB.prepare("DELETE FROM publication_media"),
    testEnv.DB.prepare("DELETE FROM publications"),
    testEnv.DB.prepare("DELETE FROM sessions"),
    testEnv.DB.prepare("DELETE FROM oauth_transactions"),
    testEnv.DB.prepare("DELETE FROM rate_limits"),
    testEnv.DB.prepare("DELETE FROM users"),
    testEnv.DB.prepare("DELETE FROM app_settings"),
  ]);
});
