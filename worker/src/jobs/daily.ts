import type { Env } from "../env";
import { log } from "../http";
import { DELIVERY_RETENTION_MS, EVENT_RETENTION_MS } from "../safety/limits";

/** Nightly full snapshot to R2 (updates + roster, never tokens). Runs before purge so rows expiring today appear in at least one snapshot. */
export async function exportAll(env: Env, now: number): Promise<string> {
  const [updates, authors, notes] = await Promise.all([
    env.LEDGER_DB.prepare("SELECT * FROM updates ORDER BY created_at").all(),
    env.LEDGER_DB.prepare("SELECT id, display_name, role, created_at, revoked_at FROM authors ORDER BY id").all(),
    env.LEDGER_DB.prepare("SELECT * FROM notes ORDER BY created_at").all(),
  ]);
  const lines = [
    ...authors.results.map((row) => JSON.stringify({ table: "authors", row })),
    ...updates.results.map((row) => JSON.stringify({ table: "updates", row })),
    ...notes.results.map((row) => JSON.stringify({ table: "notes", row })),
  ];
  const key = `exports/${new Date(now).toISOString().slice(0, 10)}.jsonl`;
  await env.EXPORTS.put(key, lines.join("\n") + "\n", { httpMetadata: { contentType: "application/x-ndjson" } });
  return key;
}

/** Hard-deletes expired rows, events past retention, and old delivery IDs. Filtering alone would keep them forever. */
export async function purge(env: Env, now: number): Promise<{ updates: number; events: number; deliveries: number; notes: number }> {
  const [u, e, d, n] = await env.LEDGER_DB.batch([
    env.LEDGER_DB.prepare("DELETE FROM updates WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now),
    // Access changes are the audit trail for who could see what; keep them.
    env.LEDGER_DB.prepare("DELETE FROM events WHERE created_at < ? AND type != 'access_changed'").bind(now - EVENT_RETENTION_MS),
    env.LEDGER_DB.prepare("DELETE FROM webhook_deliveries WHERE received_at < ?").bind(now - DELIVERY_RETENTION_MS),
    // Expired handoffs and superseded knowledge. Live knowledge has no expiry and is never purged.
    // RETURNING gives a true row count; meta.changes would also count the full-text index's trigger writes.
    env.LEDGER_DB.prepare("DELETE FROM notes WHERE expires_at IS NOT NULL AND expires_at <= ? RETURNING id").bind(now),
  ]);
  return { updates: u!.meta.changes, events: e!.meta.changes, deliveries: d!.meta.changes, notes: n!.results.length };
}

export async function runDaily(env: Env, now: number): Promise<void> {
  const key = await exportAll(env, now);
  const purged = await purge(env, now);
  log("daily job done", { export: key, purged });
}
