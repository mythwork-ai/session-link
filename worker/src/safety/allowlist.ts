import type { Env } from "../env";
import { getSetting } from "../db";
import { HttpError } from "../http";
import { normalizeRepo } from "./repo";

/** Patterns are "host/owner/name" or "host/owner/*". */
export function isAllowed(repo: string, patterns: string[]): boolean {
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase();
    return p.endsWith("/*") ? repo.startsWith(p.slice(0, -1)) : repo === p;
  });
}

/** The settings table overrides the ALLOWED_REPOS var, so the allowlist can change without a deploy. */
export async function loadAllowlist(env: Env): Promise<string[]> {
  const stored = await getSetting(env, "repo_allowlist");
  if (stored !== null) return JSON.parse(stored) as string[];
  return env.ALLOWED_REPOS.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Resolves and allowlist-checks a repo, or throws a 400/403 the caller can show as-is. */
export async function allowedRepo(env: Env, remote: string): Promise<string> {
  const repo = normalizeRepo(remote);
  if (!repo) throw new HttpError(400, "bad_repo", "repo_url is not a recognizable git remote");
  if (!isAllowed(repo, await loadAllowlist(env))) throw new HttpError(403, "repo_not_allowed", `${repo} is not on the allowlist`);
  return repo;
}
