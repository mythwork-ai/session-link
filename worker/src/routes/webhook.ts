import type { Env } from "../env";
import { recordEvent, upsertUpdate } from "../db";
import { HttpError, json, readText } from "../http";
import { isAllowed, loadAllowlist } from "../safety/allowlist";
import { PATHS_MAX, WEBHOOK_BODY_MAX_BYTES } from "../safety/limits";
import { findSecret } from "../safety/redact";
import { collapsePaths, sanitizeLine, truncate, validBranch, validPath } from "../safety/text";

const enc = new TextEncoder();

async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const got = enc.encode(header.slice("sha256=".length));
  const want = enc.encode(expected);
  if (got.byteLength !== want.byteLength) return false;
  return crypto.subtle.timingSafeEqual(got, want);
}

interface Repo { full_name: string; default_branch: string }
interface PrPayload { action: string; number: number; sender: { login: string }; repository: Repo; pull_request: { title: string; html_url: string; merged: boolean; updated_at?: string; user: { login: string }; head: { ref: string } } }
interface PushPayload { ref: string; deleted: boolean; sender: { login: string }; repository: Repo; head_commit?: { timestamp?: string } | null; commits: { added?: string[]; modified?: string[]; removed?: string[] }[] }

const MAX_AGE_MS = 30 * 86_400_000;
/** The event's own time, so replayed or backfilled events age correctly. Clamped to [now - 30d, now]. */
function eventTime(iso: string | undefined, now: number): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.min(now, Math.max(now - MAX_AGE_MS, t)) : now;
}

const PR_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "closed"]);

export async function githubWebhook(env: Env, req: Request, now: number): Promise<Response> {
  const body = await readText(req, WEBHOOK_BODY_MAX_BYTES);
  if (!(await verifySignature(env.WEBHOOK_SECRET, body, req.headers.get("x-hub-signature-256")))) {
    throw new HttpError(401, "bad_signature", "X-Hub-Signature-256 does not match");
  }
  const delivery = req.headers.get("x-github-delivery") ?? "";
  if (!/^[A-Za-z0-9-]{1,100}$/.test(delivery)) throw new HttpError(400, "bad_delivery", "missing X-GitHub-Delivery");
  const ins = await env.LEDGER_DB.prepare("INSERT OR IGNORE INTO webhook_deliveries (delivery_id, received_at) VALUES (?, ?)").bind(delivery, now).run();
  if (ins.meta.changes === 0) return json({ ok: true, duplicate: true });
  try {
    return await handle(env, req.headers.get("x-github-event"), body, now);
  } catch (e) {
    // Forget the delivery so GitHub's redelivery can succeed, then fail loudly.
    await env.LEDGER_DB.prepare("DELETE FROM webhook_deliveries WHERE delivery_id = ?").bind(delivery).run();
    throw e;
  }
}

async function handle(env: Env, event: string | null, body: string, now: number): Promise<Response> {
  const payload = JSON.parse(body) as PrPayload | PushPayload;
  if (event !== "pull_request" && event !== "push") return json({ ok: true, ignored: event });

  const ignore = async (reason: string) => {
    await recordEvent(env, "webhook_ignored", null, { reason, event }, now);
    return json({ ok: true, ignored: reason }, 202);
  };
  const repo = `github.com/${payload.repository.full_name}`.toLowerCase();
  if (!isAllowed(repo, await loadAllowlist(env))) return ignore("repo_not_allowed");
  // Only roster members count. For PRs that means the PR's author, not whoever clicked merge,
  // so an outside contributor's title never reaches anyone's context.
  const login = (event === "pull_request" ? (payload as PrPayload).pull_request.user.login : payload.sender.login).toLowerCase();
  const member = await env.LEDGER_DB.prepare("SELECT id FROM authors WHERE id = ? AND revoked_at IS NULL").bind(login).first();
  if (!member) return ignore("author_not_on_roster");

  if (event === "pull_request") {
    const p = payload as PrPayload;
    if (!PR_ACTIONS.has(p.action)) return ignore(`pr_action_${p.action}`);
    const verb = p.action === "closed" ? (p.pull_request.merged ? "merged" : "closed") : "opened";
    const title = sanitizeLine(p.pull_request.title);
    const secret = findSecret(title);
    const summary = truncate(secret ? `${verb} PR #${p.number} (title withheld: looks like a ${secret})` : `${verb} PR #${p.number}: ${title}`);
    const link = p.pull_request.html_url.startsWith("https://github.com/") ? [p.pull_request.html_url] : [];
    const branch = validBranch(p.pull_request.head.ref) ? p.pull_request.head.ref : null;
    await upsertUpdate(env, { author_id: login, kind: "pr", source: "github", repo, branch, summary, links: link, client_id: `pr:${repo}#${p.number}`, at: eventTime(p.pull_request.updated_at, now) }, now);
    return json({ ok: true, recorded: "pr" });
  }

  const p = payload as PushPayload;
  if (!p.ref.startsWith("refs/heads/") || p.deleted) return ignore("not_a_branch_push");
  const branch = p.ref.slice("refs/heads/".length);
  if (branch === p.repository.default_branch) return ignore("default_branch");
  if (!validBranch(branch) || findSecret(branch)) return ignore("bad_branch");
  const touched = p.commits.flatMap((c) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]);
  const paths = collapsePaths(touched.filter((x) => validPath(x) && !findSecret(x)), PATHS_MAX);
  const n = p.commits.length;
  await upsertUpdate(
    env,
    { author_id: login, kind: "push", source: "github", repo, branch, paths, summary: `pushed ${n} commit${n === 1 ? "" : "s"} to ${branch}`, client_id: `push:${repo}:${branch}`, at: eventTime(p.head_commit?.timestamp, now) },
    now,
  );
  return json({ ok: true, recorded: "push" });
}
