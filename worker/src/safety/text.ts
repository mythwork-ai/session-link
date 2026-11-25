import { BRANCH_MAX, PATH_LEN_MAX, SUMMARY_MAX } from "./limits";

/**
 * Flattens free text into one plain line: control characters and newlines become spaces,
 * angle brackets become look-alikes so nothing can close the hook's delimiter block,
 * backticks become apostrophes so nothing renders as code.
 */
export function sanitizeLine(s: string): string {
  return s
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(s: string, max = SUMMARY_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const PATH_RE = /^[A-Za-z0-9._\-/ @+()[\]]+$/;
export const validPath = (p: string): boolean =>
  p.length > 0 && p.length <= PATH_LEN_MAX && PATH_RE.test(p) && !p.startsWith("/") && !p.split("/").includes("..");

export const BRANCH_RE = /^[A-Za-z0-9._\-/]+$/;
export const validBranch = (b: string): boolean => b.length > 0 && b.length <= BRANCH_MAX && BRANCH_RE.test(b);

const parent = (p: string): string => (p.includes("/") ? `${p.slice(0, p.lastIndexOf("/"))}/` : p);

/** Caps a path list: while over the limit, collapse to parent directories; then hard-truncate. */
export function collapsePaths(paths: string[], max: number): string[] {
  let out = [...new Set(paths)];
  for (let i = 0; out.length > max && i < 8; i++) {
    out = [...new Set(out.map((p) => (p.endsWith("/") ? parent(p.slice(0, -1)) : parent(p))))];
  }
  return out.slice(0, max);
}
