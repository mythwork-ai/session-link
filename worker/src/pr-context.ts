import type { Env } from "./env";
import type { ViewRow } from "./db";
import { knowledgePaths, type NoteRow } from "./notes";
import { pathsOverlap } from "./overlap";
import { isAllowed, loadAllowlist } from "./safety/allowlist";

export const PR_CONTEXT_MAX = 1500;
// Teammate text is stored without HTML or backticks but may still hold markdown; escape it so a
// summary or title can't add links or images to someone else's PR.
const md = (s: string | null) => (s ?? "").replace(/[\\[\]()!*_#|~{}+]/g, "\\$&");
const ACTIVE = "(u.expires_at IS NULL OR u.expires_at > ?) AND a.revoked_at IS NULL";

/**
 * Markdown for a PR description: the caller's posts on the branch, team decisions and knowledge
 * notes whose paths overlap the branch's, and handoffs about the branch. "" when none apply.
 * Note bodies are never included, only titles and links, and all teammate text is markdown-escaped.
 */
export async function prContext(env: Env, login: string, repo: string, branch: string, now: number): Promise<string> {
  const { results: mine } = await env.LEDGER_DB.prepare(
    `SELECT u.*, a.display_name FROM updates u JOIN authors a ON a.id = u.author_id
     WHERE u.author_id = ? AND u.repo = ? AND u.branch = ? AND ${ACTIVE} ORDER BY u.updated_at DESC LIMIT 20`,
  )
    .bind(login, repo, branch, now)
    .all<ViewRow>();
  const paths = [...new Set(mine.flatMap((r) => JSON.parse(r.paths) as string[]))];
  const touches = (p: string[]) => p.some((a) => paths.some((b) => pathsOverlap(a, b)));
  const link = (id: string) => `${env.PUBLIC_URL}/notes/${id}`;

  const lines: string[] = [];
  for (const r of mine) if (r.summary && r.kind !== "heartbeat") lines.push(`- ${r.kind === "decision" ? "Decision" : "Update"}: ${md(r.summary)}`);

  if (paths.length) {
    const { results: decisions } = await env.LEDGER_DB.prepare(
      `SELECT u.*, a.display_name FROM updates u JOIN authors a ON a.id = u.author_id
       WHERE u.kind = 'decision' AND u.repo = ? AND u.author_id != ? AND ${ACTIVE} ORDER BY u.updated_at DESC LIMIT 50`,
    )
      .bind(repo, login, now)
      .all<ViewRow>();
    for (const d of decisions) if (touches(JSON.parse(d.paths) as string[])) lines.push(`- Decision by ${md(d.display_name)}: ${md(d.summary)}`);

    const seen = new Set<string>();
    for (const [p, notes] of Object.entries(await knowledgePaths(env, repo, now)))
      if (touches([p])) for (const n of notes) if (!seen.has(n.id)) (seen.add(n.id), lines.push(`- Team knowledge: [${md(n.title)}](${link(n.id)})`));
  }

  // Handoffs between two people only; a note to yourself stays out of the PR.
  const { results: handoffs } = await env.LEDGER_DB.prepare(
    `SELECT n.*, a.display_name FROM notes n JOIN authors a ON a.id = n.author_id
     WHERE n.kind = 'handoff' AND n.repo = ? AND n.branch = ? AND n.to_author != n.author_id AND (n.author_id = ? OR n.to_author = ?)
       AND (n.expires_at IS NULL OR n.expires_at > ?) AND a.revoked_at IS NULL ORDER BY n.updated_at DESC LIMIT 3`,
  )
    .bind(repo, branch, login, login, now)
    .all<NoteRow>();
  const allow = await loadAllowlist(env);
  for (const h of handoffs) if (h.repo && isAllowed(h.repo, allow)) lines.push(`- Handoff from ${md(h.display_name)}: [${md(h.title)}](${link(h.id)})`);

  if (!lines.length) return "";
  let out = "Team context (session-link):";
  for (const l of lines) {
    if (out.length + l.length + 1 > PR_CONTEXT_MAX) break;
    out += `\n${l}`;
  }
  return out;
}
