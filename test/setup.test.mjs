// Unit tests for the setup helpers (pure functions). Run: node --test test/setup.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as lib from "../worker/scripts/setup-lib.mjs";
const { checkAdmins, checkAllowlist, checkHost, checkName, managedSettings, newSecret, parseJsonc, renderConfig, seedAdminsSql } = lib;
const await_import = lib;

const template = parseJsonc(readFileSync(new URL("../worker/wrangler.template.jsonc", import.meta.url), "utf8"));
const base = { name: "acme-link", d1Id: "11111111-2222-3333-4444-555555555555", kvId: "a".repeat(32), bucket: "acme-link-exports", allowlist: ["github.com/acme/*"] };

test("the template parses and uses placeholder IDs only", () => {
  assert.equal(template.d1_databases[0].database_id, "00000000-0000-0000-0000-000000000000");
  assert.equal(template.routes, undefined);
});

test("a custom-domain config routes the domain and turns workers.dev off", () => {
  const c = renderConfig(template, { ...base, host: "session-link.acme.com", publicUrl: "https://session-link.acme.com" });
  assert.deepEqual(c.routes, [{ pattern: "session-link.acme.com", custom_domain: true }]);
  assert.equal(c.workers_dev, false);
  assert.equal(c.name, "acme-link");
  assert.equal(c.d1_databases[0].database_name, "acme-link");
  assert.equal(c.vars.PUBLIC_URL, "https://session-link.acme.com");
  assert.equal(c.vars.ALLOWED_REPOS, "github.com/acme/*");
  assert.equal(template.name, "session-link", "the template itself is not modified");
});

test("a workers.dev config has no routes", () => {
  const c = renderConfig(template, { ...base, host: "", publicUrl: "https://acme-link.acme.workers.dev" });
  assert.equal(c.routes, undefined);
  assert.equal(c.workers_dev, true);
});

test("input checks accept good values and explain bad ones", () => {
  assert.equal(checkName(" Acme-Link "), "acme-link");
  assert.throws(() => checkName("1bad"), /starting with a letter/);
  assert.equal(checkHost("https://Session-Link.Acme.com/"), "session-link.acme.com");
  assert.equal(checkHost(""), "");
  assert.throws(() => checkHost("x.workers.dev"), /leave the hostname empty/);
  assert.throws(() => checkHost("not a host"), /valid domain/);
  assert.deepEqual(checkAllowlist("github.com/Acme/*, github.com/other/app"), ["github.com/acme/*", "github.com/other/app"]);
  assert.throws(() => checkAllowlist("*"), /should look like/);
  assert.throws(() => checkAllowlist(""), /at least one/);
});

test("admins parse with optional names, and only valid logins reach SQL", () => {
  assert.deepEqual(checkAdmins("Erin=Erin, alex"), [{ login: "erin", name: "Erin" }, { login: "alex", name: "alex" }]);
  assert.throws(() => checkAdmins("bad'; DROP TABLE authors;--"), /isn't a GitHub login/);
  const sql = seedAdminsSql(checkAdmins("alice=O'Brien"), 1000);
  assert.match(sql, /\('alice', 'O''Brien', 1000, 'admin'\)/);
  assert.match(sql, /ON CONFLICT\(id\) DO NOTHING;$/, "a rerun never re-grants someone removed at /admin");
});

test("managed settings register the marketplace, enable the plugin and pre-fill its options", () => {
  const s = managedSettings({ marketplaceRepo: "acme/session-link", serverUrl: "https://session-link.acme.com", allowlist: ["github.com/acme/*"] });
  assert.deepEqual(s.extraKnownMarketplaces["session-link"], { source: { source: "github", repo: "acme/session-link" }, autoUpdate: true });
  assert.equal(s.enabledPlugins["session-link@session-link"], true);
  assert.deepEqual(s.pluginConfigs["session-link@session-link"].options, { server_url: "https://session-link.acme.com", repo_allowlist: "github.com/acme/*" });
});

test("the marketplace repo is read from the git remote, dots included", () => {
  const { githubRepo } = await_import;
  assert.equal(githubRepo("git@github.com:acme/session.link.git"), "acme/session.link");
  assert.equal(githubRepo("https://github.com/acme/session-link"), "acme/session-link");
  assert.equal(githubRepo("https://gitlab.com/acme/x.git"), null);
});

test("secrets are long and random", () => {
  const a = newSecret();
  assert.ok(a.length >= 40);
  assert.notEqual(a, newSecret());
});
