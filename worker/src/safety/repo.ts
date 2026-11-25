const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Normalizes a git remote to "host/owner/name" in lowercase, so worktrees, ssh vs https
 * and ".git" suffixes all key to one repo. Returns null for anything unrecognized.
 */
export function normalizeRepo(remote: string): string | null {
  const s = remote.trim();
  let host: string | undefined;
  let path: string | undefined;
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.+)$/.exec(s);
  const url = /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([A-Za-z0-9.-]+)(?::\d+)?\/(.+)$/.exec(s);
  const bare = /^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\/(.+)$/.exec(s);
  if (scp) [, host, path] = scp;
  else if (url) [, host, path] = url;
  else if (bare) [, host, path] = bare;
  if (!host || !path) return null;
  const parts = path.replace(/\/+$/, "").replace(/\.git$/, "").split("/");
  if (parts.length !== 2 || !parts.every((p) => SEGMENT.test(p) && p !== "." && p !== "..")) return null;
  return `${host}/${parts[0]}/${parts[1]}`.toLowerCase();
}
