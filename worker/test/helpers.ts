import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createExecutionContext, env } from "cloudflare:test";
import type { Env } from "../src/env";
import worker from "../src/index";
import { buildServer } from "../src/mcp/server";

export const E = env as unknown as Env;
export const REPO = "git@github.com:acme/app.git";
export const ADMIN = { authorization: "Bearer test-admin-token" };

export async function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const res = await worker.fetch(new Request(`https://sl.test${path}`, { method, body, headers: { "content-type": "application/json", ...opts.headers } }), E, createExecutionContext());
  return { status: res.status, json: (await res.json()) as any };
}

export async function author(id: string, name = id, role?: "viewer" | "editor" | "admin"): Promise<void> {
  await call("POST", "/v1/admin/authors", { headers: ADMIN, body: { id, display_name: name, ...(role ? { role } : {}) } });
}

/** Inserts a ledger row directly, as post_update would. */
export async function post(authorId: string, over: { kind?: string; summary?: string; repo?: string | null; branch?: string | null; paths?: string[] } = {}) {
  const now = Date.now();
  await E.LEDGER_DB.prepare(
    "INSERT INTO updates (id, author_id, kind, source, repo, branch, summary, paths, client_id, created_at, updated_at, expires_at) VALUES (?, ?, ?, 'mcp', ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), authorId, over.kind ?? "progress", over.repo === undefined ? "github.com/acme/app" : over.repo, over.branch ?? "auth-refactor", over.summary ?? "working", JSON.stringify(over.paths ?? ["src/auth/session.ts"]), crypto.randomUUID(), now, now, now + 86_400_000)
    .run();
}


/** An MCP client acting as `login`; each call returns the text, error flag and parsed payload. */
export async function mcp(login: string, now = Date.now()) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(E, login, now).connect(a);
  const c = new Client({ name: "t", version: "1" });
  await c.connect(b);
  return async (name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = r.content[0]!.text;
    return { isError: !!r.isError, text, data: r.isError ? null : JSON.parse(text.slice(text.indexOf("\n") + 1)) };
  };
}
