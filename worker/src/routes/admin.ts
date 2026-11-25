import { z } from "zod";
import type { Env } from "../env";
import { requireAdmin } from "../auth/tokens";
import { getSetting, recordEvent, setSetting } from "../db";
import { HttpError, json, readJson } from "../http";
import { loadAllowlist } from "../safety/allowlist";

const LOGIN = /^[a-z0-9-]{1,39}$/;
const PATTERN = /^[a-z0-9.-]+\/[a-z0-9._-]+\/(?:\*|[a-z0-9._-]+)$/;

const Settings = z.object({ kill_switch: z.boolean().optional(), repo_allowlist: z.array(z.string().regex(PATTERN)).min(1).max(50).optional() });
const Author = z.object({ id: z.string().regex(LOGIN), display_name: z.string().min(1).max(60), emails: z.array(z.string().email()).max(10).default([]), role: z.enum(["viewer", "editor", "admin"]).optional() });

async function parse<T>(schema: z.ZodType<T>, req: Request): Promise<T> {
  const r = schema.safeParse(await readJson(req));
  if (!r.success) throw new HttpError(400, "invalid_body", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

async function requireAuthor(env: Env, id: string): Promise<void> {
  if (!LOGIN.test(id) || !(await env.LEDGER_DB.prepare("SELECT 1 FROM authors WHERE id = ?").bind(id).first())) {
    throw new HttpError(404, "no_author", `no author ${id}`);
  }
}

export async function admin(env: Env, req: Request, path: string, now: number): Promise<Response> {
  await requireAdmin(env, req);
  const m = /^\/v1\/admin\/authors\/([^/]+)\/(revoke|unrevoke)$/.exec(path);
  const del = /^\/v1\/admin\/updates\/([0-9a-f-]{36})$/.exec(path);

  if (del && req.method === "DELETE") {
    // Hard delete, e.g. to purge a leaked secret immediately instead of waiting for expiry.
    const r = await env.LEDGER_DB.prepare("DELETE FROM updates WHERE id = ?").bind(del[1]).run();
    if (r.meta.changes === 0) throw new HttpError(404, "no_update", `no update ${del[1]}`);
    await recordEvent(env, "admin_update_deleted", null, { id: del[1] }, now);
    return json({ ok: true });
  }

  if (path === "/v1/admin/settings" && req.method === "GET") {
    return json({ kill_switch: (await getSetting(env, "kill_switch")) === "1", repo_allowlist: await loadAllowlist(env) });
  }
  if (path === "/v1/admin/settings" && req.method === "PUT") {
    const s = await parse(Settings, req);
    if (s.kill_switch !== undefined) await setSetting(env, "kill_switch", s.kill_switch ? "1" : "0");
    if (s.repo_allowlist) await setSetting(env, "repo_allowlist", JSON.stringify(s.repo_allowlist));
    await recordEvent(env, "admin_settings", null, s, now);
    return json({ ok: true });
  }
  if (path === "/v1/admin/authors" && req.method === "POST") {
    const a = await parse(Author, req);
    await env.LEDGER_DB.prepare(
      `INSERT INTO authors (id, display_name, emails, created_at, role) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, emails = excluded.emails, role = COALESCE(?6, authors.role)`,
    )
      .bind(a.id, a.display_name, JSON.stringify(a.emails), now, a.role ?? "editor", a.role ?? null)
      .run();
    await recordEvent(env, "admin_author_upsert", a.id, {}, now);
    return json({ ok: true, id: a.id });
  }
  if (path === "/v1/admin/roster" && req.method === "GET") {
    const { results } = await env.LEDGER_DB.prepare(
      `SELECT a.id, a.display_name, a.revoked_at,
              (SELECT MAX(u.updated_at) FROM updates u WHERE u.author_id = a.id AND u.source = 'mcp') AS last_post_at
       FROM authors a ORDER BY a.id`,
    ).all();
    return json({ authors: results });
  }
  if (m && req.method === "POST") {
    const id = decodeURIComponent(m[1]!);
    await requireAuthor(env, id);
    if (m[2] === "unrevoke") {
      await env.LEDGER_DB.prepare("UPDATE authors SET revoked_at = NULL WHERE id = ?").bind(id).run();
      await recordEvent(env, "admin_author_unrevoked", id, {}, now);
      return json({ ok: true });
    }
    await env.LEDGER_DB.prepare("UPDATE authors SET revoked_at = ? WHERE id = ?").bind(now, id).run();
    await recordEvent(env, "admin_author_revoked", id, {}, now);
    return json({ ok: true });
  }
  throw new HttpError(404, "not_found", `no admin route ${req.method} ${path}`);
}
