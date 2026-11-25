import type { Env } from "./env";
import { TTL_MS, type Kind } from "./safety/limits";

export interface UpdateRow {
  id: string;
  author_id: string;
  kind: Kind;
  source: "hook" | "mcp" | "github";
  repo: string | null;
  branch: string | null;
  session_id: string | null;
  summary: string | null;
  details: string | null;
  paths: string;
  links: string;
  client_id: string;
  supersedes: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.LEDGER_DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.LEDGER_DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

export const isKilled = async (env: Env): Promise<boolean> => (await getSetting(env, "kill_switch")) === "1";

export interface NewUpdate {
  author_id: string;
  kind: Kind;
  source: UpdateRow["source"];
  repo: string | null;
  branch?: string | null;
  session_id?: string | null;
  summary?: string | null;
  details?: string | null;
  paths?: string[];
  links?: string[];
  client_id: string;
  supersedes?: string | null;
  /** When the activity happened, if earlier than now (GitHub events). TTL counts from here. */
  at?: number;
}

/**
 * Insert, or update the content fields in place on (author_id, client_id), so retries and repeated
 * heartbeats never duplicate rows. created_at, source and session_id keep their first values.
 * An older event never overwrites a newer one, so out-of-order or replayed deliveries are harmless.
 */
export async function upsertUpdate(env: Env, u: NewUpdate, now: number): Promise<string | null> {
  const ttl = TTL_MS[u.kind];
  const at = Math.min(u.at ?? now, now);
  const row = await env.LEDGER_DB.prepare(
    `INSERT INTO updates (id, author_id, kind, source, repo, branch, session_id, summary, paths, links, client_id, supersedes, created_at, updated_at, expires_at, details)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14, ?15)
     ON CONFLICT(author_id, client_id) DO UPDATE SET
       kind = excluded.kind, repo = excluded.repo, branch = excluded.branch, summary = excluded.summary, details = excluded.details,
       paths = excluded.paths, links = excluded.links, supersedes = excluded.supersedes,
       updated_at = excluded.updated_at, expires_at = excluded.expires_at
     WHERE excluded.updated_at >= updates.updated_at
     RETURNING id`,
  )
    .bind(
      crypto.randomUUID(),
      u.author_id,
      u.kind,
      u.source,
      u.repo,
      u.branch ?? null,
      u.session_id ?? null,
      u.summary ?? null,
      JSON.stringify(u.paths ?? []),
      JSON.stringify(u.links ?? []),
      u.client_id,
      u.supersedes ?? null,
      at,
      ttl === null ? null : at + ttl,
      u.details ?? null,
    )
    .first<{ id: string }>();
  return row?.id ?? null; // null: a newer row already exists for this key

}

export async function recordEvent(env: Env, type: string, authorId: string | null, detail: Record<string, unknown>, now: number): Promise<void> {
  await env.LEDGER_DB.prepare("INSERT INTO events (type, author_id, detail, created_at) VALUES (?, ?, ?, ?)")
    .bind(type, authorId, JSON.stringify(detail), now)
    .run();
}

export type ViewRow = UpdateRow & { display_name: string };
const ACTIVE = "(u.expires_at IS NULL OR u.expires_at > ?) AND a.revoked_at IS NULL";

/** Active rows for one repo, newest first. Filtering by repo in SQL keeps busy repos from crowding this one out. */
export async function repoRows(env: Env, repo: string, now: number, limit = 300): Promise<ViewRow[]> {
  const { results } = await env.LEDGER_DB.prepare(
    `SELECT u.*, a.display_name FROM updates u JOIN authors a ON a.id = u.author_id
     WHERE u.repo = ? AND ${ACTIVE} ORDER BY u.updated_at DESC LIMIT ?`,
  )
    .bind(repo, now, limit)
    .all<ViewRow>();
  return results;
}

/** Recent blockers, asks and decisions from other repos. */
export async function crossRepoIntent(env: Env, repo: string, since: number, now: number, limit = 50): Promise<ViewRow[]> {
  const { results } = await env.LEDGER_DB.prepare(
    `SELECT u.*, a.display_name FROM updates u JOIN authors a ON a.id = u.author_id
     WHERE (u.repo IS NULL OR u.repo != ?) AND u.kind IN ('blocker','ask','decision') AND u.updated_at > ? AND ${ACTIVE}
     ORDER BY u.updated_at DESC LIMIT ?`,
  )
    .bind(repo, since, now, limit)
    .all<ViewRow>();
  return results;
}
