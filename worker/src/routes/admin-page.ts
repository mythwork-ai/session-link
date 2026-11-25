import type { Env } from "../env";
import { requireRole, ROLES, type Role } from "../auth/roles";
import { recordEvent } from "../db";
import { HttpError } from "../http";
import { escapeHtml } from "../web/session";
import { render, statePage, initial, type Viewer } from "../web/ui";
import { age } from "./web";

const LOGIN = /^[a-z0-9-]{1,39}$/;

interface Person {
  id: string;
  display_name: string;
  role: Role;
  revoked_at: number | null;
  last_post_at: number | null;
}

async function activeAdmins(env: Env): Promise<number> {
  return (await env.LEDGER_DB.prepare("SELECT COUNT(*) AS n FROM authors WHERE role = 'admin' AND revoked_at IS NULL").first<number>("n")) ?? 0;
}

/** Applies one admin action. Every change is logged as access_changed with who did it. */
async function apply(env: Env, actor: string, form: FormData, now: number): Promise<string> {
  const action = String(form.get("action") ?? "");
  const id = String(form.get("id") ?? "").trim().toLowerCase();
  if (!LOGIN.test(id)) throw new HttpError(400, "bad_login", "enter a GitHub login (letters, digits and dashes)");
  const role = String(form.get("role") ?? "editor") as Role;
  if (!ROLES.includes(role)) throw new HttpError(400, "bad_role", "role must be viewer, editor or admin");
  const current = await env.LEDGER_DB.prepare("SELECT role, revoked_at FROM authors WHERE id = ?").bind(id).first<{ role: Role; revoked_at: number | null }>();
  const isActiveAdmin = current?.role === "admin" && !current.revoked_at;

  if (action === "add") {
    // Adding an existing admin with a lower role is a demotion; the same guard applies.
    if (isActiveAdmin && role !== "admin" && (await activeAdmins(env)) <= 1) throw new HttpError(400, "last_admin", "make someone else an admin first; there must always be one");
    const name = String(form.get("display_name") ?? "").replace(/[\p{Cc}\p{Cf}<>`]/gu, "").trim().slice(0, 60);
    // A blank name keeps the stored one (or falls back to the login for someone new).
    await env.LEDGER_DB.prepare(
      `INSERT INTO authors (id, display_name, created_at, role) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(id) DO UPDATE SET display_name = COALESCE(NULLIF(?5, ''), authors.display_name), role = excluded.role, revoked_at = NULL`,
    )
      .bind(id, name || id, now, role, name)
      .run();
    await recordEvent(env, "access_changed", actor, { action: "add", id, role }, now);
    return `Added ${id} as ${role}.`;
  }
  if (!current) throw new HttpError(404, "no_person", `${id} isn't on the list`);
  if (action === "role") {
    if (isActiveAdmin && role !== "admin" && (await activeAdmins(env)) <= 1) throw new HttpError(400, "last_admin", "make someone else an admin first; there must always be one");
    await env.LEDGER_DB.prepare("UPDATE authors SET role = ? WHERE id = ?").bind(role, id).run();
    await recordEvent(env, "access_changed", actor, { action: "role", id, role }, now);
    return `${id} is now ${role}.`;
  }
  if (action === "remove") {
    if (isActiveAdmin && (await activeAdmins(env)) <= 1) throw new HttpError(400, "last_admin", "make someone else an admin first; there must always be one");
    await env.LEDGER_DB.prepare("UPDATE authors SET revoked_at = ? WHERE id = ?").bind(now, id).run();
    await recordEvent(env, "access_changed", actor, { action: "remove", id }, now);
    return `Removed ${id}. Their access ends now.`;
  }
  throw new HttpError(400, "bad_action", "unknown action");
}

/** /admin: admins see and change who can view, edit and manage session-link. */
export async function adminPage(env: Env, req: Request, viewer: Viewer, now: number): Promise<Response> {
  const actor = viewer.login;
  try {
    await requireRole(env, actor, "admin");
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return statePage({
      title: "Admins only",
      heading: "Only admins can manage access",
      viewer,
      status: 403,
      body: `<p class="calm">Ask an admin if someone needs to be added, removed or given a different role.</p>`,
      action: `<a class="btn" href="/feed">Back to the feed</a>`,
    });
  }
  let notice = "";
  let bad = false;
  if (req.method === "POST") {
    // CSRF: the session cookie is SameSite=Lax and the POST must come from this origin.
    if (req.headers.get("origin") !== new URL(env.PUBLIC_URL).origin) throw new HttpError(403, "bad_origin", "cross-site request refused");
    try {
      notice = await apply(env, actor, await req.formData(), now);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      notice = e.message;
      bad = true;
    }
  } else if (req.method !== "GET") {
    throw new HttpError(405, "method", "GET or POST only");
  }

  const { results: people } = await env.LEDGER_DB.prepare(
    `SELECT a.id, a.display_name, a.role, a.revoked_at,
            (SELECT MAX(u.updated_at) FROM updates u WHERE u.author_id = a.id AND u.source = 'mcp') AS last_post_at
     FROM authors a ORDER BY a.revoked_at IS NOT NULL, a.display_name`,
  ).all<Person>();
  const { results: log } = await env.LEDGER_DB.prepare(
    "SELECT author_id, detail, created_at FROM events WHERE type = 'access_changed' ORDER BY id DESC LIMIT 20",
  ).all<{ author_id: string; detail: string; created_at: number }>();

  const roleSelect = (id: string, current: Role) =>
    `<select name="role" aria-label="Role for ${escapeHtml(id)}">${ROLES.map((r) => `<option${r === current ? " selected" : ""}>${r}</option>`).join("")}</select>`;
  const active = people.filter((p) => !p.revoked_at);
  const removed = people.filter((p) => p.revoked_at);
  const person = (p: Person) => `<span class="avatar lg" aria-hidden="true">${initial(p.display_name)}</span>
<div class="grow"><span style="font-weight:600">${escapeHtml(p.display_name)}</span><span class="mono muted">${escapeHtml(p.id)} · last post ${p.last_post_at ? age(Math.round((now - p.last_post_at) / 1000)) : "never"}</span></div>`;
  const rows = active
    .map((p) => {
      const id = escapeHtml(p.id);
      return `<div class="row">${person(p)}
<form method="post" style="display:flex;gap:8px;align-items:center"><input type="hidden" name="action" value="role"><input type="hidden" name="id" value="${id}">
<label class="inline">Role ${roleSelect(p.id, p.role)}</label><button class="btn">Save</button></form>
<details class="confirm"><summary class="btn danger">Remove</summary>
<form method="post" style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="hidden" name="action" value="remove"><input type="hidden" name="id" value="${id}">
<span class="small muted">Remove ${escapeHtml(p.display_name)}? Their access ends now.</span><button class="btn danger">Yes, remove</button></form></details></div>`;
    })
    .join("");
  const removedRows = removed
    .map((p) => {
      const id = escapeHtml(p.id);
      return `<div class="row muted">${person(p)}
<form method="post" style="display:flex;gap:8px;align-items:center"><input type="hidden" name="action" value="add"><input type="hidden" name="id" value="${id}"><input type="hidden" name="display_name" value="${escapeHtml(p.display_name)}">
<label class="inline">Role ${roleSelect(p.id, p.role)}</label><button class="btn">Restore</button></form></div>`;
    })
    .join("");
  const history = log
    .map((l) => {
      const d = JSON.parse(l.detail) as { action: string; id: string; role?: string };
      return `<li>${escapeHtml(l.author_id)} ${escapeHtml(d.action)} ${escapeHtml(d.id)}${d.role ? ` → ${escapeHtml(d.role)}` : ""} · ${age(Math.round((now - l.created_at) / 1000))}</li>`;
    })
    .join("");

  return render({
    title: "Manage access",
    viewer,
    body: `<main style="gap:24px">
<div style="display:flex;flex-direction:column;gap:6px"><h1>Manage access</h1><p class="calm">Only people on this list can sign in. Removing someone ends their access right away.</p></div>
${notice ? `<p class="notice${bad ? " bad" : ""}" role="status">${escapeHtml(notice)}</p>` : ""}
<div class="roles">
<div class="card"><strong>Viewer</strong><br><span class="small muted">Reads the feed, knowledge, and handoffs sent to them.</span></div>
<div class="card"><strong>Editor</strong><br><span class="small muted">Also posts updates, hands off work, saves knowledge.</span></div>
<div class="card"><strong>Admin</strong><br><span class="small muted">Also manages this list. There's always at least one.</span></div>
</div>
<section class="card" aria-labelledby="people"><h2 id="people" style="font-size:16px;padding:14px 16px;border-bottom:1px solid var(--line)">People (${active.length})</h2>${rows}</section>
<section class="card" aria-labelledby="add" style="padding:16px;display:flex;flex-direction:column;gap:12px"><h2 id="add" style="font-size:16px">Add someone</h2>
<form method="post" style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px"><input type="hidden" name="action" value="add">
<label class="field">GitHub login <input name="id" required pattern="[A-Za-z0-9-]{1,39}" placeholder="e.g. sam"></label>
<label class="field">Name <input name="display_name" maxlength="60" placeholder="e.g. Sam"></label>
<label class="field" style="flex:0 0 auto">Role <select name="role"><option>viewer</option><option selected>editor</option><option>admin</option></select></label>
<button class="btn primary">Add</button></form></section>
${removed.length ? `<details class="card" style="padding:0 16px"><summary>Removed (${removed.length})</summary>${removedRows}</details>` : ""}
<details class="muted"><summary style="color:var(--text)">Recent changes (${log.length})</summary><ul class="small" style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px">${history || "<li>None yet.</li>"}</ul></details>
</main>`,
  });
}
