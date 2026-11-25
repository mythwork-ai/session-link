import type { Env } from "../env";
import { HttpError } from "../http";
import { sanitizeLine } from "../safety/text";

const UA = { "user-agent": "session-link", accept: "application/vnd.github+json" };

export function githubAuthorizeUrl(env: Env, state: string, redirectPath: string): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  u.searchParams.set("redirect_uri", `${env.PUBLIC_URL}${redirectPath}`);
  u.searchParams.set("scope", ""); // identity only: the roster, not GitHub org membership, decides access
  u.searchParams.set("state", state);
  u.searchParams.set("allow_signup", "false");
  return u.toString();
}

export interface GithubIdentity {
  login: string; // lowercase
  name: string;
}

/** Exchanges the callback code for the user's GitHub identity. The GitHub token is used once and never stored. */
export async function signInWithGithub(env: Env, code: string, redirectPath: string): Promise<GithubIdentity> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { ...UA, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${env.PUBLIC_URL}${redirectPath}` }),
  });
  const tok = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tok.access_token) throw new HttpError(401, "github_denied", `GitHub sign-in failed: ${tok.error ?? tokenRes.status}`);
  const userRes = await fetch("https://api.github.com/user", { headers: { ...UA, authorization: `Bearer ${tok.access_token}` } });
  if (!userRes.ok) throw new HttpError(502, "github_error", `GitHub /user returned ${userRes.status}`);
  const user = (await userRes.json()) as { login: string; name: string | null };
  // The display name is user-controlled and appears in teammates' context: flatten and cap it.
  return { login: user.login.toLowerCase(), name: sanitizeLine(user.name ?? user.login).slice(0, 60) || user.login };
}

/** Access is invite-only: the person must already be on the roster (an admin adds them) and not removed. */
export async function ensureAuthor(env: Env, who: GithubIdentity, _now: number): Promise<void> {
  const row = await env.LEDGER_DB.prepare("SELECT revoked_at FROM authors WHERE id = ?").bind(who.login).first<{ revoked_at: number | null }>();
  if (!row) throw new HttpError(403, "not_on_roster", `${who.login} doesn't have access to session-link. Ask an admin to add you.`);
  if (row.revoked_at) throw new HttpError(403, "author_revoked", `${who.login} has been removed from session-link`);
}
