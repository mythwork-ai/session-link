import type { Env } from "./env";
import { crossRepoIntent, repoRows, type UpdateRow, type ViewRow } from "./db";
import { isAllowed, loadAllowlist } from "./safety/allowlist";
import { DIGEST_OTHER_ROWS, DIGEST_PATHS_PER_ROW, DIGEST_REPO_ROWS, MAP_MAX_PATHS, OTHER_REPO_WINDOW_MS } from "./safety/limits";

export interface DigestRow {
  id?: string;
  who: string;
  author: string;
  self: boolean;
  kind: UpdateRow["kind"];
  repo: string | null;
  branch: string | null;
  paths: string[];
  more_paths: number;
  summary: string | null;
  age_s: number;
}
export interface PathOwner {
  who: string;
  author: string;
  branch: string | null;
  age_s: number;
}
export type PathMap = Record<string, PathOwner[]>;

interface Viewer {
  repo: string;
  authorId: string;
  sessionId: string;
  now: number;
}

function toRow(r: ViewRow, self: boolean, now: number): DigestRow {
  const paths = JSON.parse(r.paths) as string[];
  return {
    who: self ? "you (other session)" : r.display_name,
    author: r.author_id,
    self,
    kind: r.kind,
    repo: r.repo,
    branch: r.branch,
    paths: paths.slice(0, DIGEST_PATHS_PER_ROW),
    more_paths: Math.max(0, paths.length - DIGEST_PATHS_PER_ROW),
    summary: r.summary,
    age_s: Math.max(0, Math.round((now - r.updated_at) / 1000)),
  };
}

/**
 * What one session should see. Your own rows are hidden, except heartbeats from your
 * other sessions in the same repo, shown as "you (other session)": parallel worktrees
 * collide with themselves too. Rows from repos no longer on the allowlist are hidden.
 */
export async function buildView(env: Env, v: Viewer): Promise<{ rows: DigestRow[]; other: DigestRow[]; map: PathMap }> {
  const allow = await loadAllowlist(env);
  const [local, cross] = await Promise.all([repoRows(env, v.repo, v.now), crossRepoIntent(env, v.repo, v.now - OTHER_REPO_WINDOW_MS, v.now)]);
  const rows: DigestRow[] = [];
  // Null-prototype object: a file named "constructor" or "__proto__" must be an ordinary key.
  const map: PathMap = Object.create(null) as PathMap;
  let mapped = 0;

  for (const r of local) {
    const self = r.author_id === v.authorId;
    if (self && !(r.kind === "heartbeat" && r.session_id !== null && r.session_id !== v.sessionId)) continue;
    const row = toRow(r, self, v.now);
    if (rows.length < DIGEST_REPO_ROWS) rows.push(row);
    // Any row that names paths marks them as in progress: posts and (webhook) pushes.
    for (const p of JSON.parse(r.paths) as string[]) {
      if (!Object.hasOwn(map, p)) {
        if (mapped >= MAP_MAX_PATHS) continue;
        map[p] = [];
        mapped++;
      }
      map[p]!.push({ who: row.who, author: r.author_id, branch: r.branch, age_s: row.age_s });
    }
  }
  const other = cross
    .filter((r) => r.author_id !== v.authorId && (r.repo === null || isAllowed(r.repo, allow)))
    .slice(0, DIGEST_OTHER_ROWS)
    .map((r) => toRow(r, false, v.now));
  return { rows, other, map };
}
