import type { Env } from "./env";
import { recordEvent } from "./db";
import { buildView } from "./ledger";

const WINDOW_MS = 4 * 3_600_000;

/** Paths overlap when equal, or when one is a directory entry ("src/auth/") containing the other. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || (a.endsWith("/") && b.startsWith(a)) || (b.endsWith("/") && a.startsWith(b));
}

/**
 * When someone shares paths that teammates are also changing in the same repo, count it once
 * per pair, repo and 4-hour window for the trial report. Only logins, the repo and a file count
 * are stored, never the paths themselves.
 */
export async function recordOverlaps(env: Env, login: string, repo: string, paths: string[], now: number): Promise<number> {
  if (!paths.length) return 0;
  const { map } = await buildView(env, { repo, authorId: login, sessionId: "mcp", now });
  const files = new Map<string, number>();
  for (const [key, owners] of Object.entries(map)) {
    if (!paths.some((p) => pathsOverlap(p, key))) continue;
    for (const author of new Set(owners.map((o) => o.author).filter((a) => a && a !== login))) files.set(author, (files.get(author) ?? 0) + 1);
  }
  const window = Math.floor(now / WINDOW_MS);
  const windowStart = window * WINDOW_MS;
  let recorded = 0;
  for (const [other, count] of files) {
    const pair = [login, other].sort().join("|");
    const key = `${pair}|${repo}|${window}`;
    const seen = await env.LEDGER_DB.prepare("SELECT 1 FROM events WHERE created_at >= ? AND type = 'overlap_detected' AND json_extract(detail, '$.key') = ?").bind(windowStart, key).first();
    if (seen) continue;
    await recordEvent(env, "overlap_detected", login, { key, with: other, repo, files: count }, now);
    recorded++;
  }
  return recorded;
}
