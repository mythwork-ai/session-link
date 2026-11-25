#!/usr/bin/env node
// Sets up (or updates) one session-link instance for your org in your Cloudflare account.
//
//   npm run setup                         # asks for everything
//   npm run setup -- --name acme-link --host session-link.acme.com \
//     --allowlist "github.com/acme/*" --admins "alice=Alice,bob" [--skip-github]
//
// Safe to run again: it reuses existing resources and secrets and only fills in what's missing.
// It never prints a secret. Uses wrangler (installed with `npm ci`) and Node's standard library.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { checkAdmins, checkAllowlist, checkHost, checkName, githubRepo, managedSettings, newSecret, parseJsonc, renderConfig, seedAdminsSql } from "./setup-lib.mjs";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(WORKER, "wrangler.jsonc");
const TEMPLATE = join(WORKER, "wrangler.template.jsonc");

const flags = Object.fromEntries(
  // "--flag value" (an empty value counts, e.g. --host "") or a bare "--flag" (true).
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), i + 1 < all.length && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : [])),
);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const say = (s = "") => console.log(s);
const fail = (msg) => {
  console.error(`\nsetup stopped: ${msg}`);
  process.exit(1);
};

async function ask(label, key, fallback, check, hint = "") {
  const flag = flags[key] ?? fallback;
  if (flag !== undefined && flag !== true) return check(String(flag));
  if (flags.yes) fail(`--${key} is required with --yes`);
  for (;;) {
    const v = await rl.question(`${label}${hint ? ` (${hint})` : ""}: `);
    try {
      return check(v);
    } catch (e) {
      say(`  ${e.message}`);
    }
  }
}

/** Hidden input for secrets: nothing typed is echoed. */
async function askSecret(label) {
  const out = rl.output;
  const write = rl._writeToOutput;
  out.write(`${label}: `);
  rl._writeToOutput = () => {};
  const v = await rl.question("");
  rl._writeToOutput = write;
  out.write("\n");
  return v.trim();
}

function wrangler(args, { input, show = false } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], { cwd: WORKER, encoding: "utf8", input, stdio: show ? "inherit" : ["pipe", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  if (r.error) fail(`could not run wrangler: ${r.error.message}`);
  // stdout alone for parsing (wrangler prints warnings on stderr); both for error messages.
  return { ok: r.status === 0, stdout: r.stdout ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const must = (r, what) => (r.ok ? r.out : fail(`${what} failed:\n${r.out.trim().slice(-1500)}`));
const mustJson = (r, what) => {
  must(r, what);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return fail(`${what}: wrangler didn't return JSON:\n${r.out.trim().slice(-1500)}`);
  }
};

function marketplaceRepo() {
  if (typeof flags.marketplace === "string") return flags.marketplace;
  const r = spawnSync("git", ["-C", WORKER, "remote", "get-url", "origin"], { encoding: "utf8" });
  const repo = githubRepo(r.stdout ?? "");
  if (!repo) say("   note: couldn't read a GitHub remote for this checkout; replace OWNER/REPO below with the repo members install the plugin from (or pass --marketplace owner/repo)");
  return repo ?? "OWNER/REPO";
}

function saveAdminToken(name, token) {
  const k = spawnSync("security", ["add-generic-password", "-U", "-s", "session-link-admin-token", "-a", name, "-w", token], { encoding: "utf8" });
  if (k.status === 0) return `macOS keychain (service "session-link-admin-token", account "${name}")`;
  const dir = join(homedir(), ".session-link");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${name}-admin-token`);
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

async function main() {
  say("session-link setup: one instance for your org, in your Cloudflare account.\n");
  const existing = existsSync(CONFIG) ? parseJsonc(readFileSync(CONFIG, "utf8")) : null;

  const name = await ask("Instance name", "name", existing?.name, checkName, "e.g. acme-session-link");
  if (existing && existing.name !== name) fail(`worker/wrangler.jsonc already belongs to "${existing.name}". Run with --name ${existing.name}, or move that file aside first.`);
  const existingHost = existing?.routes?.[0]?.pattern ?? "";
  const host = await ask("Custom domain on a Cloudflare zone you own", "host", existing ? existingHost : undefined, checkHost, "leave empty for a free workers.dev address");
  const allowlist = await ask("Repos this team shares status for", "allowlist", existing?.vars?.ALLOWED_REPOS, checkAllowlist, "comma-separated, e.g. github.com/acme/*");
  const admins = await ask("First admins' GitHub logins", "admins", undefined, checkAdmins, "comma-separated, optionally login=Name");

  say("\n1/7 Cloudflare login");
  if (/not authenticated/i.test(wrangler(["whoami"]).out)) must(wrangler(["login"], { show: true }), "wrangler login");

  say("2/7 Database, key-value store and backup bucket");
  const d1List = mustJson(wrangler(["d1", "list", "--json"]), "listing D1 databases");
  let d1Id = d1List.find((d) => d.name === name)?.uuid;
  if (!d1Id) {
    const out = must(wrangler(["d1", "create", name]), "creating the D1 database");
    d1Id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(out)?.[1] ?? fail(`couldn't read the new database id from:\n${out}`);
  }
  const kvTitle = `${name}-oauth`;
  const kvList = mustJson(wrangler(["kv", "namespace", "list"]), "listing KV namespaces");
  let kvId = kvList.find((k) => k.title === kvTitle)?.id;
  if (!kvId) {
    const out = must(wrangler(["kv", "namespace", "create", kvTitle]), "creating the KV namespace");
    kvId = /"id":\s*"([0-9a-f]{32})"|id = "([0-9a-f]{32})"/.exec(out)?.slice(1).find(Boolean) ?? fail(`couldn't read the new KV id from:\n${out}`);
  }
  const bucket = `${name}-exports`;
  const buckets = must(wrangler(["r2", "bucket", "list"]), "listing R2 buckets");
  if (!new RegExp(`^name:\\s+${bucket}$`, "m").test(buckets)) must(wrangler(["r2", "bucket", "create", bucket]), "creating the R2 bucket (R2 must be enabled on the account)");

  const template = parseJsonc(readFileSync(TEMPLATE, "utf8"));
  const write = (publicUrl) =>
    writeFileSync(CONFIG, `// Generated by npm run setup for "${name}". Not committed; rerun setup to change it.\n${JSON.stringify(renderConfig(template, { name, d1Id, kvId, bucket, host, publicUrl, allowlist }), null, 2)}\n`);
  let publicUrl = host ? `https://${host}` : existing?.vars?.PUBLIC_URL?.includes(".workers.dev") ? existing.vars.PUBLIC_URL : "http://localhost:8787";
  write(publicUrl);

  say("3/7 Database tables");
  must(wrangler(["d1", "migrations", "apply", "LEDGER_DB", "--remote"], { input: "y\n" }), "applying migrations");

  say("4/7 Deploy");
  let deployOut = must(wrangler(["deploy"]), "deploying");
  if (!host) {
    const url = /(https:\/\/[a-z0-9.-]+\.workers\.dev)/.exec(deployOut)?.[1] ?? fail(`couldn't find the workers.dev address in:\n${deployOut}`);
    if (url !== publicUrl) {
      publicUrl = url;
      write(publicUrl);
      deployOut = must(wrangler(["deploy"]), "redeploying with the public address");
    }
  }
  say(`   live at ${publicUrl}`);

  say("5/7 Secrets");
  const have = new Set(mustJson(wrangler(["secret", "list"]), "listing secrets").map((s) => s.name));
  for (const secret of ["WEBHOOK_SECRET", "COOKIE_KEY", "ADMIN_TOKEN"]) {
    if (have.has(secret)) continue;
    const value = newSecret();
    // Save the admin token locally first, so a failure after setting it can't lose it.
    if (secret === "ADMIN_TOKEN") say(`   admin token saved to ${saveAdminToken(name, value)}`);
    must(wrangler(["secret", "put", secret], { input: value }), `setting ${secret}`);
  }

  say("6/7 GitHub sign-in");
  const moved = existing?.vars?.PUBLIC_URL && existing.vars.PUBLIC_URL !== publicUrl;
  if (have.has("GITHUB_CLIENT_ID") && have.has("GITHUB_CLIENT_SECRET") && !flags["reset-github"]) {
    say("   already set (rerun with --reset-github to replace)");
    if (moved) say(`   the address changed: add ${publicUrl}/callback and ${publicUrl}/callback/web to the GitHub OAuth app's redirect URIs`);
  } else if (flags["skip-github"]) {
    say("   skipped: nobody can sign in until GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set (rerun setup)");
  } else {
    say(`   Create a GitHub OAuth app at https://github.com/settings/applications/new
     Application name:  ${name}
     Homepage URL:      ${publicUrl}
     Redirect URIs:     ${publicUrl}/callback   and   ${publicUrl}/callback/web
   Then generate a client secret.`);
    if (flags.yes && !(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)) fail("with --yes, set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in the environment, or pass --skip-github");
    const id = process.env.GITHUB_CLIENT_ID || (await rl.question("   Client ID: ")).trim();
    const secret = process.env.GITHUB_CLIENT_SECRET || (await askSecret("   Client secret (hidden)"));
    if (!id || !secret) fail("both the client ID and secret are needed");
    must(wrangler(["secret", "put", "GITHUB_CLIENT_ID"], { input: id }), "setting GITHUB_CLIENT_ID");
    must(wrangler(["secret", "put", "GITHUB_CLIENT_SECRET"], { input: secret }), "setting GITHUB_CLIENT_SECRET");
  }

  say("7/7 Admins");
  must(wrangler(["d1", "execute", "LEDGER_DB", "--remote", "--command", seedAdminsSql(admins, Date.now())]), "adding the admins");
  let healthy = false;
  for (let i = 0; i < 12 && !healthy; i++) {
    healthy = await fetch(`${publicUrl}/v1/health`).then((r) => r.ok, () => false);
    if (!healthy) await new Promise((r) => setTimeout(r, 5000));
  }
  say(healthy ? `   ${publicUrl}/v1/health is ok` : `   ${publicUrl} isn't answering yet (a new custom domain's certificate can take a few minutes); check /v1/health shortly`);

  const settings = managedSettings({ marketplaceRepo: marketplaceRepo(), serverUrl: publicUrl, allowlist });
  say(`
Done. ${admins.map((a) => a.login).join(", ")} can manage access at ${publicUrl}/admin.

Roll it out to everyone (recommended): a Claude org owner pastes this into
claude.ai → Organization settings → Claude Code → Managed settings:

${JSON.stringify(settings, null, 2)}

Or each person, once:
  /plugin marketplace add ${marketplaceRepo()}
  ! claude plugin install session-link@session-link --scope user
  /plugin → session-link → settings: ${publicUrl} and ${allowlist.join(",")} (and Share presence, if they want it)
  new session, then /mcp → session-link "ledger" → sign in with GitHub
  (user scope, not project: a project install doesn't reach repos in subfolders)
`);
  rl.close();
}

main().catch((e) => fail(e.stack ?? String(e)));
