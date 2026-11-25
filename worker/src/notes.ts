import type { Env } from "./env";
import { recordEvent } from "./db";
import { HttpError } from "./http";
import { isAllowed, loadAllowlist } from "./safety/allowlist";
import { PATHS_MAX } from "./safety/limits";
import { findSecret } from "./safety/redact";
import { collapsePaths, sanitizeLine, validBranch, validPath } from "./safety/text";

const DAY = 86_400_000;
export const BODY_MAX = 16_000;
export const TITLE_MAX = 120;
const HANDOFF_OPEN_TTL = 30 * DAY;
const HANDOFF_ACCEPTED_TTL = 14 * DAY;
export const SELF_NOTE_TTL = 14 * DAY;

export interface NoteRow {
  id: string;
  author_id: string;
  display_name: string;
  kind: "handoff" | "knowledge";
  title: string;
  body: string;
  tags: string;
  repo: string | null;
  branch: string | null;
  paths: string;
  links: string;
  to_author: string | null;
  status: string | null;
  updated_at: number;
  expires_at: number | null;
}

/**
 * Multi-line markdown that will be read by other people's agents: keep newlines and tabs, drop
 * other control and invisible formatting characters, and replace angle brackets so nothing can
 * close a delimiter or render as HTML. Rejects (never silently trims) oversize or secret-looking text.
 */
export function cleanBody(raw: string): string {
  const body = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\p{Cf}]/gu, "")
    .replace(/\r\n?/g, "\n")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .trim();
  if (body.length < 20) throw new HttpError(400, "too_short", "body is too short to be useful; write a few sentences");
  if (body.length > BODY_MAX) throw new HttpError(400, "too_long", `body is ${body.length} characters; keep it under ${BODY_MAX}`);
  const secret = findSecret(body);
  if (secret) throw new HttpError(422, "looks_like_secret", `not saved: the body looks like it contains a ${secret}. Remove it and try again.`);
  return body;
}

export function cleanTitle(raw: string): string {
  const title = sanitizeLine(raw);
  if (title.length < 3 || title.length > TITLE_MAX) throw new HttpError(400, "bad_title", `title must be 3 to ${TITLE_MAX} characters`);
  const secret = findSecret(title);
  if (secret) throw new HttpError(422, "looks_like_secret", `not saved: the title looks like it contains a ${secret}`);
  return title;
}

export function cleanPaths(paths: string[] | undefined): string[] {
  const bad = (paths ?? []).filter((p) => !validPath(p) || findSecret(p));
  if (bad.length) throw new HttpError(400, "bad_paths", `paths must be repo-relative with no '..': ${bad.slice(0, 3).join(", ")}`);
  return collapsePaths(paths ?? [], PATHS_MAX);
}

export function cleanBranch(branch: string | undefined): string | null {
  if (!branch) return null;
  if (!validBranch(branch) || findSecret(branch)) throw new HttpError(400, "bad_branch", "branch has characters outside [A-Za-z0-9._-/]");
  return branch;
}

export interface NewNote {
  author_id: string;
  kind: NoteRow["kind"];
  title: string;
  body: string;
  tags?: string[];
  repo: string | null;
  branch?: string | null;
  paths?: string[];
  links?: string[];
  to_author?: string | null;
  client_id: string;
  supersedes?: string | null;
  /** Handoffs only: lifetime while open, if not the default 30 days (notes to yourself use 14). */
  ttl?: number;
}

/** Insert, or update in place on (author_id, client_id) so retries never duplicate a note. */
export async function upsertNote(env: Env, n: NewNote, now: number): Promise<string> {
  const expires = n.kind === "handoff" ? now + (n.ttl ?? HANDOFF_OPEN_TTL) : null;
  const row = await env.LEDGER_DB.prepare(
    `INSERT INTO notes (id, author_id, kind, title, body, tags, repo, branch, paths, links, to_author, status, client_id, supersedes, created_at, updated_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ?16)
     ON CONFLICT(author_id, client_id) DO UPDATE SET
       title = excluded.title, body = excluded.body, tags = excluded.tags, repo = excluded.repo, branch = excluded.branch,
       paths = excluded.paths, links = excluded.links, to_author = excluded.to_author, supersedes = excluded.supersedes,
       updated_at = excluded.updated_at, expires_at = excluded.expires_at
     RETURNING id`,
  )
    .bind(
      crypto.randomUUID(), n.author_id, n.kind, n.title, n.body, JSON.stringify(n.tags ?? []), n.repo, n.branch ?? null,
      JSON.stringify(n.paths ?? []), JSON.stringify(n.links ?? []), n.to_author ?? null, n.kind === "handoff" ? "open" : null,
      n.client_id, n.supersedes ?? null, now, expires,
    )
    .first<{ id: string }>();
  if (!row) throw new Error("upsertNote returned no row");
  return row.id;
}

const SELECT = `SELECT n.*, a.display_name FROM notes n JOIN authors a ON a.id = n.author_id`;
// Knowledge outlives its author's access: revoking someone hides their handoffs, not what they taught the team.
const LIVE = `(n.expires_at IS NULL OR n.expires_at > ?) AND (n.kind = 'knowledge' OR a.revoked_at IS NULL)`;

async function visible(env: Env, rows: NoteRow[]): Promise<NoteRow[]> {
  const allow = await loadAllowlist(env);
  return rows.filter((r) => r.repo === null || isAllowed(r.repo, allow));
}

/** A note's full content. Handoffs are private to their author and recipient; knowledge is team-wide. */
export async function getNote(env: Env, id: string, viewer: string, now: number): Promise<NoteRow> {
  const row = await env.LEDGER_DB.prepare(`${SELECT} WHERE n.id = ? AND ${LIVE}`).bind(id, now).first<NoteRow>();
  if (!row || !(await visible(env, [row])).length) throw new HttpError(404, "no_note", "no such note");
  if (row.kind === "handoff" && row.author_id !== viewer && row.to_author !== viewer) throw new HttpError(404, "no_note", "no such note");
  return row;
}

export async function acceptHandoff(env: Env, id: string, viewer: string, now: number): Promise<NoteRow> {
  const note = await getNote(env, id, viewer, now);
  if (note.kind !== "handoff" || note.to_author !== viewer) throw new HttpError(403, "not_yours", "only the person it was handed to can accept it");
  if (note.status === "accepted") return note; // already taken on; accepting again changes nothing
  await env.LEDGER_DB.prepare("UPDATE notes SET status = 'accepted', updated_at = ?, expires_at = ? WHERE id = ?").bind(now, now + HANDOFF_ACCEPTED_TTL, id).run();
  await recordEvent(env, "handoff_accepted", viewer, { from: note.author_id }, now);
  return { ...note, status: "accepted" };
}

export async function handoffsFor(env: Env, login: string, now: number): Promise<NoteRow[]> {
  const { results } = await env.LEDGER_DB.prepare(`${SELECT} WHERE n.kind = 'handoff' AND n.to_author = ? AND n.status = 'open' AND ${LIVE} ORDER BY n.author_id = n.to_author, n.updated_at DESC LIMIT 15`)
    .bind(login, now)
    .all<NoteRow>();
  return visible(env, results);
}

export async function recentKnowledge(env: Env, repo: string | null, now: number, limit: number): Promise<NoteRow[]> {
  const where = repo ? "n.repo = ? AND" : "";
  const args = repo ? [repo, now, limit] : [now, limit];
  const { results } = await env.LEDGER_DB.prepare(`${SELECT} WHERE ${where} n.kind = 'knowledge' AND ${LIVE} ORDER BY n.updated_at DESC LIMIT ?`)
    .bind(...args)
    .all<NoteRow>();
  return visible(env, results);
}

const STOP = new Set(["a", "an", "and", "are", "do", "does", "for", "how", "in", "is", "it", "of", "on", "or", "the", "to", "what", "when", "where", "which", "who", "why", "with"]);

/**
 * Turns free text into a safe FTS5 query: words only, each quoted, any may match (OR), so a
 * natural question still finds notes; FTS5's bm25 rank puts notes matching more words first.
 */
export function ftsQuery(q: string): string {
  const all = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const words = [...new Set(all.map((w) => w.toLowerCase()).filter((w) => !STOP.has(w)))].slice(0, 12);
  if (!words.length) throw new HttpError(400, "bad_query", "search needs at least one meaningful word");
  return words.map((w) => `"${w}"`).join(" OR ");
}

export async function searchKnowledge(env: Env, q: string, repo: string | null, limit: number, now: number): Promise<(NoteRow & { snippet: string })[]> {
  const where = repo ? "AND n.repo = ?" : "";
  const args: unknown[] = [ftsQuery(q), now, ...(repo ? [repo] : []), limit];
  const { results } = await env.LEDGER_DB.prepare(
    `SELECT n.*, a.display_name, snippet(notes_fts, 1, '[', ']', '…', 16) AS snippet
     FROM notes_fts JOIN notes n ON n.rid = notes_fts.rowid JOIN authors a ON a.id = n.author_id
     WHERE notes_fts MATCH ? AND n.kind = 'knowledge' AND ${LIVE} ${where}
     ORDER BY rank LIMIT ?`,
  )
    .bind(...args)
    .all<NoteRow & { snippet: string }>();
  return (await visible(env, results)) as (NoteRow & { snippet: string })[];
}

/** Retire an older note the caller wrote, when a new one replaces it. */
export async function retire(env: Env, id: string, author: string, now: number): Promise<void> {
  const r = await env.LEDGER_DB.prepare("UPDATE notes SET expires_at = ? WHERE id = ? AND author_id = ? AND kind = 'knowledge'").bind(now, id, author).run();
  if (r.meta.changes === 0) throw new HttpError(404, "no_note", "supersedes must name one of your own knowledge notes");
}

/** Knowledge notes for a repo, indexed by the paths they list ("Where things live"), for the pre-edit hint. */
const KNOWLEDGE_PATHS_MAX = 200;

export async function knowledgePaths(env: Env, repo: string, now: number): Promise<Record<string, { id: string; title: string }[]>> {
  const { results } = await env.LEDGER_DB.prepare(
    `${SELECT} WHERE n.kind = 'knowledge' AND n.repo = ? AND n.paths != '[]' AND ${LIVE} ORDER BY n.updated_at DESC LIMIT 100`,
  )
    .bind(repo, now)
    .all<NoteRow>();
  const index: Record<string, { id: string; title: string }[]> = Object.create(null);
  let n = 0;
  for (const note of await visible(env, results)) {
    for (const p of JSON.parse(note.paths) as string[]) {
      if (!Object.hasOwn(index, p)) {
        if (n >= KNOWLEDGE_PATHS_MAX) continue;
        index[p] = [];
        n++;
      }
      if (index[p]!.length < 3) index[p]!.push({ id: note.id, title: note.title });
    }
  }
  return index;
}

export const summarize = (n: NoteRow, now: number) => ({
  id: n.id,
  kind: n.kind,
  title: n.title,
  from: n.display_name,
  author: n.author_id,
  to: n.to_author,
  ...(n.kind === "handoff" && n.to_author === n.author_id ? { self: true } : {}),
  status: n.status,
  repo: n.repo,
  branch: n.branch,
  age_s: Math.round((now - n.updated_at) / 1000),
});
