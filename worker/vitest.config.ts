import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.template.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            WEBHOOK_SECRET: "test-webhook-secret",
            ADMIN_TOKEN: "test-admin-token",
            PUBLIC_URL: "https://sl.test",
            ALLOWED_REPOS: "github.com/acme/*",
            OPERATORS: "opuser",
            GITHUB_CLIENT_ID: "gh-client",
            GITHUB_CLIENT_SECRET: "gh-secret",
            COOKIE_KEY: "test-cookie-key-that-is-at-least-32-chars",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
