import type { Env } from "../env";
import { safeEqual } from "../auth/tokens";
import { ensureAuthor, githubAuthorizeUrl, signInWithGithub } from "../auth/github";
import { canManage, getRole, requireRole } from "../auth/roles";
import { HttpError, json } from "../http";
import { feedRows } from "../mcp/server";
import { POSTS_MAX, acceptHandoff, getNote, handoffsFor, myNotes, recentKnowledge, searchKnowledge, type NoteMeta, type NoteRow } from "../notes";
import { isAllowed, loadAllowlist } from "../safety/allowlist";
import { escapeHtml, readSession, sessionCookie } from "../web/session";
import { ICON_GITHUB, detailsFold, initial, render, renderNoteBody, statePage, type Viewer } from "../web/ui";
import { adminPage } from "./admin-page";

const STATE_COOKIE = "__Host-sl-state";
// Where sign-in may send people back to: the feed, your notes, or a single note (shared links).
const safeNext = (next: string | null): string => (next && (next === "/feed" || next === "/me" || /^\/notes\/[0-9a-f-]{36}$/.test(next)) ? next : "/feed");

export const age = (s: number) => (s < 90 ? "just now" : s < 5400 ? `${Math.floor(s / 60)}m ago` : s < 172800 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`);
const ago = (now: number, t: number) => age(Math.max(0, Math.round((now - t) / 1000)));

/** The signed-in viewer, or a sign-in page to return instead. */
export async function requireSession(env: Env, req: Request, now: number, next: string): Promise<Viewer | Response> {
  const login = await readSession(env, req, now);
  if (login) return { login, role: await getRole(env, login), manage: await canManage(env, login) };
  return statePage({
    title: "Sign in",
    heading: "session-link",
    status: 401,
    body: `<p class="calm">Your team's shared status for Claude sessions. Sign in to see what everyone is working on.</p>`,
    action: `<a class="btn primary" href="/login?next=${encodeURIComponent(safeNext(next))}">${ICON_GITHUB} Sign in with GitHub</a>
<p class="calm tiny">Only people an admin has added can get in. GitHub just confirms who you are.</p>`,
  });
}

async function adminNames(env: Env): Promise<string[]> {
  const { results } = await env.LEDGER_DB.prepare("SELECT display_name FROM authors WHERE role = 'admin' AND revoked_at IS NULL ORDER BY display_name").all<{ display_name: string }>();
  return results.map((r) => r.display_name);
}

const VERB: Record<string, string> = { progress: "posted progress", status: "posted status", blocker: "is blocked", ask: "is asking", decision: "made a decision", pr: "updated a PR", push: "pushed", heartbeat: "is working" };

interface Latest {
  id: string;
  display_name: string;
  kind: string | null;
  summary: string | null;
  details: string | null;
  paths: string | null;
  repo: string | null;
  branch: string | null;
  updated_at: number | null;
}

async function feedPage(env: Env, req: Request, viewer: Viewer, now: number): Promise<Response> {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 200);
  const showAll = url.searchParams.get("all") === "1";
  const since = now - 48 * 3_600_000;
  const allow = await loadAllowlist(env);

  // Needs you: handoffs addressed to the viewer. Notes they left themselves get their own section.
  const all = await handoffsFor(env, viewer.login, now);
  const handoffs = all.filter((n) => n.author_id !== viewer.login);
  const mine = all.filter((n) => n.author_id === viewer.login);
  const leftOff = mine.length
    ? `<section class="needs" aria-labelledby="left-off"><h2 id="left-off" class="eyebrow">Where you left off</h2>
${mine
  .map(
    (n) => `<a class="handoff" href="/notes/${escapeHtml(n.id)}"><span style="font-weight:600">${escapeHtml(n.title)}</span>
<span class="mono muted">${escapeHtml(n.repo ?? "team")}${n.branch ? ` · ${escapeHtml(n.branch)}` : ""}</span>
<span class="muted small" style="margin-left:auto">${ago(now, n.updated_at)}</span><span class="btn" style="min-height:36px">Open note</span></a>`,
  )
  .join("")}</section>`
    : "";
  const needs = handoffs.length
    ? `<section class="needs" aria-labelledby="needs"><h2 id="needs" class="eyebrow">Needs you</h2>
${handoffs
  .map(
    (n) => `<a class="handoff" href="/notes/${escapeHtml(n.id)}"><span style="font-weight:600">${escapeHtml(n.display_name)} handed you “${escapeHtml(n.title)}”</span>
<span class="mono muted">${escapeHtml(n.repo ?? "team")}${n.branch ? ` · ${escapeHtml(n.branch)}` : ""}</span>
<span class="muted small" style="margin-left:auto">${ago(now, n.updated_at)}</span><span class="btn primary" style="min-height:36px">Open handoff</span></a>`,
  )
  .join("")}</section>`
    : `<p class="calm">Nothing needs you right now.</p>`;
  const top = needs + leftOff;

  // Team now: each person's latest update from the last 48 hours.
  const { results: team } = await env.LEDGER_DB.prepare(
    `SELECT a.id, a.display_name, u.kind, u.summary, u.details, u.paths, u.repo, u.branch, u.updated_at
     FROM authors a LEFT JOIN updates u ON u.id = (
       SELECT u2.id FROM updates u2 WHERE u2.author_id = a.id AND u2.updated_at > ?1 AND (u2.expires_at IS NULL OR u2.expires_at > ?2)
       ORDER BY u2.updated_at DESC LIMIT 1)
     WHERE a.revoked_at IS NULL
     ORDER BY u.updated_at IS NULL, u.updated_at DESC, a.display_name`,
  )
    .bind(since, now)
    .all<Latest>();
  const people = team
    .map((p) => {
      const has = p.updated_at !== null && (p.repo === null || isAllowed(p.repo, allow));
      const warn = has && p.kind === "blocker";
      // Presence rows carry no summary: say what's in progress instead.
      const working = has && p.kind === "heartbeat";
      const where = has ? [p.repo ?? "team", working ? null : p.branch].filter(Boolean).join(" · ") : "";
      const files = working ? (JSON.parse(p.paths ?? "[]") as string[]).length : 0;
      const text = working ? `Working on ${p.branch ?? "a branch"} · ${files} file${files === 1 ? "" : "s"}` : (p.summary ?? "");
      return `<article class="card person${warn ? " warn" : ""}"><span class="avatar lg" aria-hidden="true">${initial(p.display_name)}</span>
<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px"><span style="font-weight:600">${escapeHtml(p.display_name)}</span>
<span class="chip${warn ? " warn" : ""}">${escapeHtml(has ? (working ? "working" : (p.kind ?? "")) : "no updates")}</span></div>
<span class="muted small" style="white-space:nowrap">${has ? ago(now, p.updated_at!) : ""}</span>
<div class="body"><span${has ? "" : ' class="muted"'}>${has ? escapeHtml(text) : "Nothing shared in the last 48 hours."}</span>${where ? `<span class="mono muted">${escapeHtml(where)}</span>` : ""}${has ? detailsFold(p.details) : ""}</div></article>`;
    })
    .join("");

  // Last 48 hours: newest first, five unless the viewer asks for all.
  const rows = await feedRows(env, now, { sinceHours: 48, limit: 100 });
  const shown = showAll ? rows : rows.slice(0, 5);
  const activity = shown.length
    ? `<ol class="timeline card">${shown
        .map(
          (r) => `<li><span class="small"><strong style="font-weight:600">${escapeHtml(r.who)}</strong> <span class="muted">${escapeHtml(VERB[r.kind] ?? r.kind)}</span></span>
<span class="small">${escapeHtml(r.summary ?? `${r.branch ? `${r.branch} · ` : ""}${r.paths.length} file${r.paths.length === 1 ? "" : "s"}`)}</span>${detailsFold(r.details)}<span class="tiny muted">${age(r.age_s)}${r.repo ? ` · ${escapeHtml(r.repo)}` : ""}</span></li>`,
        )
        .join("")}${!showAll && rows.length > 5 ? `<li style="padding:0"><a class="more" href="/feed?all=1">Show all ${rows.length}</a></li>` : ""}</ol>`
    : `<p class="calm">Nothing shared in the last 48 hours.</p>`;

  // Team knowledge: search results, or the newest notes.
  let notes: NoteRow[] = [];
  let searchError = "";
  if (q.trim()) {
    try {
      notes = await searchKnowledge(env, q, null, 20, now);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      searchError = e.message;
    }
  } else {
    notes = await recentKnowledge(env, null, now, 6);
  }
  const cards = notes
    .map(
      (n) => `<a class="card note" href="/notes/${escapeHtml(n.id)}"><span style="font-weight:600">${escapeHtml(n.title)}</span>
${"snippet" in n ? `<span class="small muted">${escapeHtml(String((n as NoteRow & { snippet: string }).snippet))}</span>` : ""}
<span class="tiny muted">${escapeHtml(n.display_name)} · ${escapeHtml(n.repo ?? "team")} · ${ago(now, n.updated_at)}</span></a>`,
    )
    .join("");
  const knowledgeHead = q.trim() ? `Knowledge matching “${escapeHtml(q)}”` : "Team knowledge";
  const knowledgeEmpty = searchError ? escapeHtml(searchError) : q.trim() ? "No matches." : "No knowledge saved yet. Claude offers to save a note when a feature lands.";

  return render({
    title: "Team status",
    viewer,
    q,
    body: `<main>${top}
<div class="cols">
<section class="col-main" aria-labelledby="team"><div class="head"><h2 id="team">Team now</h2><span class="muted small">latest from each person</span></div>${people}</section>
<section class="col-side" aria-labelledby="act"><div class="head"><h2 id="act">Last 48 hours</h2></div>${activity}</section>
</div>
<section aria-labelledby="know" style="display:flex;flex-direction:column;gap:12px"><div class="head"><h2 id="know">${knowledgeHead}</h2><span class="muted small">how things work and why · never expires</span></div>
${cards ? `<div class="notes">${cards}</div>` : `<p class="calm">${knowledgeEmpty}</p>`}</section>
</main>`,
  });
}

/** One linked row for a note on /me: title, repo and branch, a status chip, and age. */
function noteRow(n: NoteMeta, now: number, title: string, chip: [label: string, open: boolean] | null): string {
  const done = chip !== null && !chip[1];
  return `<li${done ? ' class="done"' : ""}><a class="row" href="/notes/${escapeHtml(n.id)}"><span class="grow"><span class="title" style="font-weight:600">${escapeHtml(title)}</span>
<span class="mono muted">${escapeHtml(n.repo ?? "team")}${n.branch ? ` · ${escapeHtml(n.branch)}` : ""}</span></span>${chip ? `<span class="chip ${chip[1] ? "open" : "done"}">${escapeHtml(chip[0])}</span>` : ""}<span class="muted small">${ago(now, n.updated_at)}</span></a></li>`;
}

async function mePage(env: Env, viewer: Viewer, now: number): Promise<Response> {
  const m = await myNotes(env, viewer.login, now);
  const recent = await feedRows(env, now, { author: viewer.login, notKind: "heartbeat", sinceHours: 168, limit: POSTS_MAX + 1 });
  const posts = recent.slice(0, POSTS_MAX);
  // A footer whenever a list holds back items, so a capped list never reads as complete.
  const capNote = (shown: number, total: number) => (total > shown ? `Showing ${shown} of ${total}.` : "");
  const open = (n: NoteMeta) => n.status === "open";
  const sections: { id: string; name: string; hint: string; empty: string; items: string[]; count: string; footer: string }[] = [
    { id: "left-off", name: "Notes to yourself", hint: "expire 14 days after you save or pick them up", empty: "No notes to yourself. Claude offers to save one when you stop mid-task.",
      count: String(m.self.total), footer: capNote(m.self.items.length, m.self.total), items: m.self.items.map((n) => noteRow(n, now, n.title, open(n) ? ["open", true] : ["picked up", false])) },
    { id: "to-you", name: "Handed to you", hint: "open 30 days · kept 14 days after you take it on", empty: "Nobody has handed you anything.",
      count: String(m.toYou.total), footer: capNote(m.toYou.items.length, m.toYou.total), items: m.toYou.items.map((n) => noteRow(n, now, `${n.display_name}: ${n.title}`, open(n) ? ["open", true] : ["you took it on", false])) },
    { id: "from-you", name: "You handed off", hint: "see whether they've picked it up", empty: "You haven't handed anything off.",
      count: String(m.fromYou.total), footer: capNote(m.fromYou.items.length, m.fromYou.total), items: m.fromYou.items.map((n) => { const to = n.to_name ?? n.to_author ?? ""; return noteRow(n, now, `To ${to}: ${n.title}`, open(n) ? ["waiting", true] : [`${to} took it on`, false]); }) },
    { id: "knowledge", name: "Your knowledge notes", hint: "team-wide · never expire", empty: "You haven't saved any knowledge notes.",
      count: String(m.knowledge.total), footer: capNote(m.knowledge.items.length, m.knowledge.total), items: m.knowledge.items.map((n) => noteRow(n, now, n.title, null)) },
    { id: "posts", name: "Your posts", hint: "last 7 days · status posts expire after 2 days, decisions never", empty: "Nothing posted in the last 7 days.",
      count: recent.length > POSTS_MAX ? `${POSTS_MAX}+` : String(posts.length), footer: recent.length > POSTS_MAX ? `Showing the latest ${POSTS_MAX}.` : "",
      items: posts.map((r) => `<li><div class="row"><span class="grow"><span class="small">${escapeHtml(r.summary ?? `${r.branch ? `${r.branch} · ` : ""}${r.paths.length} file${r.paths.length === 1 ? "" : "s"}`)}</span>
${detailsFold(r.details)}<span class="tiny muted">${age(r.age_s)} · ${escapeHtml(r.kind)}${r.repo ? ` · ${escapeHtml(r.repo)}` : ""}${r.branch ? ` · ${escapeHtml(r.branch)}` : ""}</span></span></div></li>`) },
  ];
  return render({
    title: "Your notes",
    viewer,
    onMe: true,
    body: `<main style="max-width:900px">
<div style="display:flex;flex-direction:column;gap:12px"><h1>Your notes</h1>
<p class="calm">Everything you wrote or were handed, including what's already picked up. Notes to yourself are private to you. A handoff is private to you and the other person.</p>
<nav class="jump" aria-label="Sections">${sections.map((s) => `<a href="#${s.id}">${s.name} <span class="n">${s.count}</span></a>`).join("")}</nav></div>
${sections
  .map(
    (s) => `<section style="display:flex;flex-direction:column;gap:12px" aria-labelledby="${s.id}"><div class="head"><h2 id="${s.id}">${s.name}</h2><span class="muted small">${s.hint}</span></div>
${s.items.length ? `<ul class="list card">${s.items.join("")}</ul>` : `<p class="calm">${s.empty}</p>`}${s.footer ? `<p class="calm small">${s.footer}</p>` : ""}</section>`,
  )
  .join("\n")}
</main>`,
  });
}

async function notePage(env: Env, viewer: Viewer, id: string, now: number, notice = "", bad = false): Promise<Response> {
  let n: NoteRow;
  try {
    n = await getNote(env, id, viewer.login, now);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      return statePage({
        title: "Not found",
        heading: "Nothing here",
        viewer,
        status: 404,
        body: `<p class="calm">This note doesn't exist, has expired, or is a handoff between two other people.</p>`,
        action: `<a class="btn" href="/feed">Back to the feed</a>`,
      });
    }
    throw e;
  }
  const isHandoff = n.kind === "handoff";
  const toMe = isHandoff && n.to_author === viewer.login;
  const selfNote = isHandoff && n.to_author === n.author_id;
  const badge = selfNote ? "Note to yourself" : isHandoff ? (toMe ? "Handoff to you" : "Handoff") : "Team knowledge";
  // The recipient's display name, as people know them; their login if they're no longer on the roster.
  const toName = n.to_author ? ((await env.LEDGER_DB.prepare("SELECT display_name FROM authors WHERE id = ?").bind(n.to_author).first<string>("display_name")) ?? n.to_author) : "";
  const byline = selfNote
    ? `Where you left off · ${ago(now, n.updated_at)} · ${n.status === "open" ? "open" : "picked up"}`
    : isHandoff
    ? `From ${escapeHtml(n.display_name)} to ${escapeHtml(toName)} · ${ago(now, n.updated_at)} · ${escapeHtml(n.status ?? "")}`
    : `By ${escapeHtml(n.display_name)} · updated ${ago(now, n.updated_at)}`;
  const paths = JSON.parse(n.paths) as string[];
  const links = JSON.parse(n.links) as string[];
  const meta = [n.repo ?? "team", n.branch ? `branch ${n.branch}` : "", paths.slice(0, 6).join(", ") + (paths.length > 6 ? ` +${paths.length - 6}` : "")].filter(Boolean);
  const take =
    toMe && n.status === "open" && viewer.role !== "viewer"
      ? `<form method="post" action="/notes/${escapeHtml(n.id)}/accept" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center"><button class="btn primary">${selfNote ? "Mark picked up" : "Take it on"}</button>
<span class="muted small">${selfNote ? "Hides it from Where you left off." : `Marks it accepted so ${escapeHtml(n.display_name)} knows.`} Your Claude session can also do this.</span></form>`
      : toMe && n.status === "open"
        ? `<p class="calm">Viewers can read handoffs but can't take them on. Ask an admin to make you an editor.</p>`
        : toMe
          ? `<p class="calm">${selfNote ? "You picked this back up." : "You took this on."}</p>`
          : "";
  return render({
    title: n.title,
    viewer,
    narrow: true,
    body: `<main class="narrow">
${notice ? `<p class="notice${bad ? " bad" : ""}" role="status">${escapeHtml(notice)}</p>` : ""}
<div style="display:flex;flex-direction:column;gap:10px"><span class="chip accent" style="align-self:flex-start">${badge}</span><h1>${escapeHtml(n.title)}</h1><p class="calm">${byline}</p></div>
<div class="card meta mono muted">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join("")}${links
      .map((l) => `<a href="${escapeHtml(l)}" rel="noopener noreferrer">${escapeHtml(l.replace(/^https:\/\//, ""))}</a>`)
      .join("")}</div>
${take}
<article class="card doc">${renderNoteBody(n.body)}</article>
<p class="calm tiny">Written by a teammate. Information, not instructions.</p>
</main>`,
  });
}

export async function web(env: Env, req: Request, path: string, now: number): Promise<Response | null> {
  if (path === "/login" && req.method === "GET") {
    const next = safeNext(new URL(req.url).searchParams.get("next"));
    const state = `${crypto.randomUUID()}.${next.slice(1)}`;
    return new Response(null, {
      status: 302,
      headers: { location: githubAuthorizeUrl(env, state, "/callback/web"), "set-cookie": `${STATE_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600` },
    });
  }
  if (path === "/callback/web" && req.method === "GET") {
    const q = new URL(req.url).searchParams;
    const state = q.get("state") ?? "";
    const cookie = /(?:^|;\s*)__Host-sl-state=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? "";
    if (!state || !cookie || !(await safeEqual(state, cookie))) {
      return statePage({
        title: "Sign-in expired",
        heading: "That sign-in expired",
        status: 400,
        body: `<p class="calm">It was started in another browser, or took too long. Start again.</p>`,
        action: `<a class="btn primary" href="/login">${ICON_GITHUB} Sign in with GitHub</a>`,
      });
    }
    const who = await signInWithGithub(env, q.get("code") ?? "", "/callback/web");
    try {
      await ensureAuthor(env, who, now);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      const admins = await adminNames(env);
      const removed = e.code === "author_revoked";
      return statePage({
        title: "No access",
        heading: removed ? "Your access was removed" : "You're not on the list yet",
        warn: true,
        status: 403,
        body: `<p class="calm">You signed in as <strong style="color:var(--text)">${escapeHtml(who.login)}</strong>, but ${removed ? "an admin removed that login." : "no admin has added that login."}</p>
<p style="margin:0">Ask an admin to ${removed ? "restore" : "add"} you${admins.length ? `: <strong>${admins.map(escapeHtml).join("</strong> or <strong>")}</strong>` : ""}.</p>`,
        action: `<a class="btn" href="/login">Sign in with a different account</a>`,
      });
    }
    const headers = new Headers({ location: `${env.PUBLIC_URL}${safeNext(`/${state.slice(state.indexOf(".") + 1)}`)}` });
    headers.append("set-cookie", await sessionCookie(env, who.login, now));
    headers.append("set-cookie", `${STATE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    return new Response(null, { status: 302, headers });
  }

  if (path === "/feed.json" && req.method === "GET") {
    const login = await readSession(env, req, now);
    if (!login) throw new HttpError(401, "unauthorized", "sign in at /login first");
    const q = new URL(req.url).searchParams;
    const sinceHours = Number(q.get("since_hours") ?? "48");
    if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168) throw new HttpError(400, "bad_since", "since_hours must be an integer from 1 to 168");
    const author = q.get("author") === "me" ? login : (q.get("author") ?? undefined);
    if (author && !/^[a-z0-9-]{1,39}$/i.test(author)) throw new HttpError(400, "bad_author", "author must be a GitHub login or 'me'");
    const res = json({ rows: await feedRows(env, now, { author, sinceHours, limit: 200 }) });
    res.headers.set("cache-control", "no-store");
    return res;
  }

  if (path === "/" || path === "/feed") {
    if (req.method !== "GET") return null;
    const v = await requireSession(env, req, now, "/feed");
    return v instanceof Response ? v : feedPage(env, req, v, now);
  }

  if (path === "/me" && req.method === "GET") {
    const v = await requireSession(env, req, now, "/me");
    return v instanceof Response ? v : mePage(env, v, now);
  }

  if (path === "/admin") {
    const v = await requireSession(env, req, now, "/feed");
    return v instanceof Response ? v : adminPage(env, req, v, now);
  }

  const accept = /^\/notes\/([0-9a-f-]{36})\/accept$/.exec(path);
  if (accept && req.method === "POST") {
    const v = await requireSession(env, req, now, `/notes/${accept[1]}`);
    if (v instanceof Response) return v;
    // CSRF: the session cookie is SameSite=Lax and the POST must come from this origin.
    if (req.headers.get("origin") !== new URL(env.PUBLIC_URL).origin) throw new HttpError(403, "bad_origin", "cross-site request refused");
    try {
      await requireRole(env, v.login, "editor");
      const n = await acceptHandoff(env, accept[1]!, v.login, now);
      return notePage(env, v, n.id, now, `You took this on. ${n.display_name} can see it's accepted.`);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status === 404) throw e;
      return notePage(env, v, accept[1]!, now, e.message, true);
    }
  }

  const noteMatch = /^\/notes\/([0-9a-f-]{36})$/.exec(path);
  if (noteMatch && req.method === "GET") {
    const v = await requireSession(env, req, now, path);
    return v instanceof Response ? v : notePage(env, v, noteMatch[1]!, now);
  }

  return null;
}
