// Pure helpers for scripts/setup.mjs, kept separate so they can be unit tested.
import { randomBytes } from "node:crypto";

/** Strips full-line // comments (the template uses only those; URLs inside strings are safe). */
export function parseJsonc(text) {
  return JSON.parse(text.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"));
}

const NAME = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PATTERN = /^[a-z0-9.-]+\/[a-z0-9._-]+\/(?:\*|[a-z0-9._-]+)$/; // same rule as the Worker's admin API
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

export function checkName(v) {
  const s = v.trim().toLowerCase();
  if (!NAME.test(s)) throw new Error("instance name: 3-32 characters, lowercase letters, digits and dashes, starting with a letter");
  return s;
}

/** A custom domain, or "" for the free workers.dev address. */
export function checkHost(v) {
  const s = v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (s === "") return "";
  if (!HOST.test(s)) throw new Error(`hostname "${s}" isn't a valid domain name`);
  if (s.endsWith(".workers.dev")) throw new Error("leave the hostname empty to use workers.dev");
  return s;
}

export function checkAllowlist(v) {
  const list = v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) throw new Error("give at least one repo pattern, e.g. github.com/acme/*");
  for (const p of list) if (!PATTERN.test(p)) throw new Error(`repo pattern "${p}" should look like github.com/acme/* or github.com/acme/app`);
  return list;
}

/** "erin=Erin, alex" → [{login, name}]; logins are validated, so they're safe to put in SQL. */
export function checkAdmins(v) {
  const list = v.split(",").map((s) => s.trim()).filter(Boolean).map((item) => {
    const [rawLogin, ...rest] = item.split("=");
    const login = rawLogin.trim().toLowerCase();
    if (!LOGIN.test(login)) throw new Error(`"${rawLogin.trim()}" isn't a GitHub login`);
    const name = (rest.join("=").trim() || login).replace(/[^\p{L}\p{N} .'-]/gu, "").slice(0, 60) || login;
    return { login, name };
  });
  if (!list.length) throw new Error("give at least one admin's GitHub login");
  return list;
}

export function renderConfig(template, c) {
  const cfg = structuredClone(template);
  cfg.name = c.name;
  cfg.d1_databases[0].database_name = c.name;
  cfg.d1_databases[0].database_id = c.d1Id;
  cfg.kv_namespaces[0].id = c.kvId;
  cfg.r2_buckets[0].bucket_name = c.bucket;
  cfg.vars.ALLOWED_REPOS = c.allowlist.join(",");
  cfg.vars.PUBLIC_URL = c.publicUrl;
  if (c.host) {
    cfg.routes = [{ pattern: c.host, custom_domain: true }];
    cfg.workers_dev = false;
  } else {
    delete cfg.routes;
    cfg.workers_dev = true;
  }
  return cfg;
}

const sqlText = (s) => `'${s.replace(/'/g, "''")}'`;
export function seedAdminsSql(admins, nowMs) {
  const rows = admins.map((a) => `(${sqlText(a.login)}, ${sqlText(a.name)}, ${Math.floor(nowMs)}, 'admin')`).join(", ");
  // Only adds people who aren't on the list yet: a rerun never undoes a removal or demotion made at /admin.
  return `INSERT INTO authors (id, display_name, created_at, role) VALUES ${rows} ON CONFLICT(id) DO NOTHING;`;
}

/** What an org admin pastes into Claude's managed settings so every member is set up automatically. */
export function managedSettings({ marketplaceRepo, serverUrl, allowlist }) {
  return {
    extraKnownMarketplaces: { "session-link": { source: { source: "github", repo: marketplaceRepo }, autoUpdate: true } },
    enabledPlugins: { "session-link@session-link": true },
    pluginConfigs: { "session-link@session-link": { options: { server_url: serverUrl, repo_allowlist: allowlist.join(",") } } },
  };
}

export const newSecret = () => randomBytes(36).toString("base64url");

/** owner/repo from a GitHub remote URL (dots allowed in names), or null. */
export function githubRepo(remote) {
  const m = /github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
