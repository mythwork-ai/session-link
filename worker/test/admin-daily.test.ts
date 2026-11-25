import { createScheduledController, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { exportAll, purge } from "../src/jobs/daily";
import { ADMIN, E, author, call, post } from "./helpers";

describe("admin", () => {
  it("requires the admin token", async () => {
    expect((await call("GET", "/v1/admin/settings")).status).toBe(401);
    expect((await call("GET", "/v1/admin/settings", { headers: { authorization: "Bearer nope" } })).status).toBe(403);
  });

  it("re-adding an author does not un-revoke them; unrevoke is explicit", async () => {
    await author("erin");
    await call("POST", "/v1/admin/authors/erin/revoke", { headers: ADMIN });
    await call("POST", "/v1/admin/authors", { headers: ADMIN, body: { id: "erin", display_name: "Erin" } });
    expect(await E.LEDGER_DB.prepare("SELECT revoked_at FROM authors WHERE id='erin'").first("revoked_at")).not.toBeNull();
    await call("POST", "/v1/admin/authors/erin/unrevoke", { headers: ADMIN });
    expect(await E.LEDGER_DB.prepare("SELECT revoked_at FROM authors WHERE id='erin'").first("revoked_at")).toBeNull();
  });

  it("hard-deletes a single row", async () => {
    await author("erin");
    await post("erin");
    const id = await E.LEDGER_DB.prepare("SELECT id FROM updates").first<string>("id");
    expect((await call("DELETE", `/v1/admin/updates/${id}`, { headers: ADMIN })).status).toBe(200);
    expect(await E.LEDGER_DB.prepare("SELECT COUNT(*) AS n FROM updates").first("n")).toBe(0);
    expect((await call("DELETE", `/v1/admin/updates/${id}`, { headers: ADMIN })).status).toBe(404);
  });

  it("validates allowlist patterns", async () => {
    const r = await call("PUT", "/v1/admin/settings", { headers: ADMIN, body: { repo_allowlist: ["*"] } });
    expect(r.status).toBe(400);
  });

  it("roster shows each person's last post", async () => {
    await author("erin");
    await author("pat");
    await post("erin");
    const byId = Object.fromEntries((await call("GET", "/v1/admin/roster", { headers: ADMIN })).json.authors.map((a: any) => [a.id, a]));
    expect(byId.erin.last_post_at).toBeGreaterThan(0);
    expect(byId.pat.last_post_at).toBeNull();
  });

  it("the v1 hook-token routes are gone", async () => {
    for (const [m, p] of [["POST", "/v1/heartbeat"], ["GET", "/v1/digest"], ["POST", "/v1/events"], ["GET", "/tokens"]]) {
      expect((await call(m!, p!)).status).toBe(404);
    }
    expect((await call("POST", "/v1/admin/authors/erin/tokens", { headers: ADMIN })).status).toBe(404);
  });
});

describe("daily job", () => {
  it("purges expired rows and old events, keeps decisions", async () => {
    await author("erin");
    const now = Date.now();
    const ins = (kind: string, exp: number | null) =>
      E.LEDGER_DB.prepare("INSERT INTO updates (id, author_id, kind, source, client_id, created_at, updated_at, expires_at) VALUES (?, 'erin', ?, 'mcp', ?, 0, 0, ?)")
        .bind(crypto.randomUUID(), kind, crypto.randomUUID(), exp)
        .run();
    await ins("status", now - 1);
    await ins("status", now + 60_000);
    await ins("decision", null);
    await E.LEDGER_DB.prepare("INSERT INTO events (type, created_at) VALUES ('old', ?), ('new', ?)").bind(now - 31 * 86_400_000, now).run();
    expect(await purge(E, now)).toMatchObject({ updates: 1, events: 1 });
    const kinds = (await E.LEDGER_DB.prepare("SELECT kind FROM updates ORDER BY kind").all<{ kind: string }>()).results.map((r) => r.kind);
    expect(kinds).toEqual(["decision", "status"]);
  });

  it("exports updates and roster to R2", async () => {
    await author("erin");
    await post("erin");
    const key = await exportAll(E, Date.UTC(2026, 10, 24));
    expect(key).toBe("exports/2026-11-24.jsonl");
    const text = await (await E.EXPORTS.get(key))!.text();
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.table)).toEqual(["authors", "updates"]);
  });

  it("scheduled handler runs export + purge", async () => {
    const ctx = createExecutionContext();
    const today = `exports/${new Date().toISOString().slice(0, 10)}.jsonl`;
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "17 7 * * *" }), E, ctx);
    await waitOnExecutionContext(ctx);
    expect(await E.EXPORTS.head(today)).not.toBeNull();
  });
});
