import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env } from "../src/env";

const e = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(e.LEDGER_DB, e.TEST_MIGRATIONS);

beforeEach(async () => {
  for (const t of ["events", "webhook_deliveries", "updates", "notes", "authors", "settings"]) {
    await e.LEDGER_DB.prepare(`DELETE FROM ${t}`).run();
  }
});
