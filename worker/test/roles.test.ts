import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { buildServer } from "../src/mcp/server";
import { sessionCookie } from "../src/web/session";
import { E, REPO, author, post } from "./helpers";

async function client(login: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(E, login, Date.now()).connect(a);
  const c = new Client({ name: "t", version: "1" });
  await c.connect(b);
  return async (name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: !!r.isError, text: r.content[0]!.text };
  };
}
const BODY = "## Goal\nSomething worth handing off, with enough detail to be useful.";
const cookie = async (login: string) => (await sessionCookie(E, login, Date.now())).split(";")[0]!;
async function admin(login: string, form?: Record<string, string>, origin = "https://sl.test") {
  const init: RequestInit = { headers: { cookie: await cookie(login) }, redirect: "manual" };
  if (form) Object.assign(init, { method: "POST", body: new URLSearchParams(form), headers: { cookie: await cookie(login), origin, "content-type": "application/x-www-form-urlencoded" } });
  const r = await worker.fetch(new Request("https://sl.test/admin", init), E, createExecutionContext());
  return { status: r.status, body: await r.text() };
}
const roleOf = (id: string) => E.LEDGER_DB.prepare("SELECT role, revoked_at FROM authors WHERE id = ?").bind(id).first<{ role: string; revoked_at: number | null }>();

describe("roles in the MCP tools", () => {
  it("a viewer can read but every write is refused", async () => {
    await author("casey", "Casey", "viewer");
    await author("erin", "Erin", "editor");
    await post("erin");
    const v = await client("casey");
    expect((await v("read_feed", { repo_url: REPO })).isError).toBe(false);
    expect((await v("search_knowledge", { query: "anything" })).isError).toBe(false);
    for (const [tool, args] of [
      ["post_update", { kind: "status", summary: "hello there" }],
      ["save_knowledge", { title: "Something", body: BODY }],
      ["create_handoff", { to: "erin", title: "Something", body: BODY, repo_url: REPO }],
      ["delete_my_update", { id: crypto.randomUUID() }],
      ["accept_handoff", { id: crypto.randomUUID() }],
    ] as const) {
      expect((await v(tool, args)).text, tool).toMatch(/your role is viewer/);
    }
  });

  it("an editor can write, and can't hand work to a viewer", async () => {
    await author("erin", "Erin", "editor");
    await author("casey", "Casey", "viewer");
    const e = await client("erin");
    expect((await e("post_update", { kind: "status", summary: "hello there" })).isError).toBe(false);
    expect((await e("create_handoff", { to: "casey", title: "Something", body: BODY, repo_url: REPO })).text).toMatch(/viewer and can't take on work/);
  });
});

describe("/admin", () => {
  it("only admins can open it; the feed links to it for admins only", async () => {
    await author("erin", "Erin", "admin");
    await author("pat", "Pat", "editor");
    expect((await admin("pat")).status).toBe(403);
    expect((await admin("erin")).body).toContain("Manage access");
    const feed = async (who: string) => (await worker.fetch(new Request("https://sl.test/feed", { headers: { cookie: await cookie(who) } }), E, createExecutionContext())).text();
    expect(await feed("erin")).toContain('href="/admin"');
    expect(await feed("pat")).not.toContain('href="/admin"');
  });

  it("an admin adds someone, changes their role, removes and restores them, all logged", async () => {
    await author("erin", "Erin", "admin");
    expect((await admin("erin", { action: "add", id: "sam", display_name: "Sam", role: "viewer" })).body).toContain("Added sam as viewer.");
    expect(await roleOf("sam")).toEqual({ role: "viewer", revoked_at: null });
    await admin("erin", { action: "role", id: "sam", role: "editor" });
    expect((await roleOf("sam"))!.role).toBe("editor");
    await admin("erin", { action: "remove", id: "sam" });
    expect((await roleOf("sam"))!.revoked_at).not.toBeNull();
    expect((await (await client("sam"))("read_feed", {})).isError).toBe(false); // in-process server; the HTTP handler checks revocation
    await admin("erin", { action: "add", id: "sam", display_name: "Sam", role: "editor" });
    expect(await roleOf("sam")).toEqual({ role: "editor", revoked_at: null });
    const page = await admin("erin");
    expect(page.body).toContain("erin add sam → viewer");
    expect(page.body).toContain("erin remove sam");
  });

  it("there is always at least one admin", async () => {
    await author("erin", "Erin", "admin");
    expect((await admin("erin", { action: "role", id: "erin", role: "editor" })).body).toContain("there must always be one");
    expect((await admin("erin", { action: "remove", id: "erin" })).body).toContain("there must always be one");
    await author("alex", "Alex", "admin");
    await admin("erin", { action: "role", id: "erin", role: "editor" });
    expect((await roleOf("erin"))!.role).toBe("editor");
  });

  it("Add can't demote the last admin, and a blank name keeps the stored one", async () => {
    await author("erin", "Erin", "admin");
    expect((await admin("erin", { action: "add", id: "erin", display_name: "", role: "viewer" })).body).toContain("there must always be one");
    expect((await roleOf("erin"))!.role).toBe("admin");
    await author("pat", "Pat", "viewer");
    await admin("erin", { action: "add", id: "pat", display_name: "", role: "editor" });
    expect(await E.LEDGER_DB.prepare("SELECT display_name FROM authors WHERE id='pat'").first("display_name")).toBe("Pat");
  });

  it("refuses cross-site posts and bad input", async () => {
    await author("erin", "Erin", "admin");
    expect((await admin("erin", { action: "add", id: "x", role: "admin" }, "https://evil.test")).status).toBe(403);
    expect((await admin("erin", { action: "add", id: "bad login!", role: "editor" })).body).toContain("enter a GitHub login");
    expect((await admin("erin", { action: "add", id: "ok", role: "owner" })).body).toContain("role must be viewer, editor or admin");
    expect((await admin("erin", { action: "add", id: "ok", display_name: "<script>x</script>", role: "editor" })).body).not.toContain("<script>x");
  });
});

describe("operators", () => {
  it("an operator shows as an editor everywhere but can manage access", async () => {
    await author("erin", "Erin", "admin");
    await author("opuser", "Op", "editor");
    const feed = await (await worker.fetch(new Request("https://sl.test/feed", { headers: { cookie: await cookie("opuser") } }), E, createExecutionContext())).text();
    expect(feed).toContain('href="/admin"');
    expect(feed).toContain("· editor");
    expect(feed).not.toContain("· admin");
    expect((await admin("opuser")).status).toBe(200);
    expect((await admin("opuser", { action: "add", id: "newbie", display_name: "New", role: "viewer" })).body).toContain("Added newbie as viewer.");
    expect(await roleOf("opuser")).toEqual({ role: "editor", revoked_at: null });
  });

  it("an operator isn't named as an admin, doesn't count toward the last-admin guard, and loses powers when removed", async () => {
    await author("erin", "Erin", "admin");
    await author("opuser", "Op", "editor");
    expect((await admin("opuser", { action: "role", id: "erin", role: "editor" })).body).toContain("there must always be one");
    await admin("erin", { action: "remove", id: "opuser" });
    expect((await admin("opuser")).status).not.toBe(200);
  });

  it("an ordinary editor still can't manage access", async () => {
    await author("pat", "Pat", "editor");
    expect((await admin("pat")).status).toBe(403);
  });
});

describe("hosting", () => {
  it("the old workers.dev address forwards to the public host", async () => {
    const r = await worker.fetch(new Request("https://session-link.acme.workers.dev/feed?q=x", { redirect: "manual" }), E, createExecutionContext());
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("https://sl.test/feed?q=x");
  });
});
