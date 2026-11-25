#!/usr/bin/env node
// Seeds the ledger with the last 7 days of GitHub PRs and branch pushes, so the first digests
// aren't empty. It replays them as signed webhook deliveries to /v1/gh, so they pass the same
// allowlist, roster, redaction and dedupe checks as live events. Safe to re-run: delivery IDs
// are stable, so repeats are ignored.
//
//   WEBHOOK_SECRET=... node scripts/backfill.mjs --org acme --url https://<worker> [--send]
//
// Without --send it only prints what it would replay. Uses your `gh` login to read GitHub.
// Each payload carries the event's original time, and the Worker ages the row from it, so a
// six-day-old push lands already expired and a PR keeps only its remaining days.
// Push events from the org events API carry no file lists, so backfilled pushes have no paths.
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const org = arg("--org");
const url = arg("--url")?.replace(/\/+$/, "");
const send = process.argv.includes("--send");
const secret = process.env.WEBHOOK_SECRET;
if (!org || !url || (send && !secret)) {
  console.error("usage: WEBHOOK_SECRET=... node scripts/backfill.mjs --org <org> --url https://<worker> [--send]");
  process.exit(2);
}
const since = Date.now() - 7 * 86_400_000;
const gh = (path) => JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8", maxBuffer: 64 << 20 })).flat();

const repos = gh(`orgs/${org}/repos?per_page=100`).filter((r) => !r.archived);
const defaults = new Map(repos.map((r) => [r.full_name, r.default_branch]));
const deliveries = [];

for (const r of repos) {
  if (Date.parse(r.pushed_at) < since) continue;
  const pulls = JSON.parse(execFileSync("gh", ["api", `repos/${r.full_name}/pulls?state=all&sort=updated&direction=desc&per_page=50`], { encoding: "utf8" }));
  for (const p of pulls.filter((p) => Date.parse(p.updated_at) >= since)) {
    deliveries.push({
      id: `backfill-pr-${p.id}-${Date.parse(p.updated_at)}`,
      event: "pull_request",
      payload: {
        action: p.state === "open" ? "opened" : "closed",
        number: p.number,
        sender: { login: p.user.login },
        repository: { full_name: r.full_name, default_branch: r.default_branch },
        pull_request: { title: p.title, html_url: p.html_url, merged: !!p.merged_at, updated_at: p.updated_at, user: { login: p.user.login }, head: { ref: p.head.ref } },
      },
    });
  }
}

// orgs/{org}/events lists public events only; the signed-in member's org feed includes private repos.
const me = execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" }).trim();
for (const e of gh(`users/${me}/events/orgs/${org}?per_page=100`)) {
  if (e.type !== "PushEvent" || Date.parse(e.created_at) < since || !defaults.has(e.repo.name)) continue;
  deliveries.push({
    id: `backfill-push-${e.id}`,
    event: "push",
    payload: {
      ref: e.payload.ref,
      deleted: false,
      sender: { login: e.actor.login },
      repository: { full_name: e.repo.name, default_branch: defaults.get(e.repo.name) },
      head_commit: { timestamp: e.created_at },
      // The events API gives a commit count but no file lists; empty commits keep the count right.
      commits: Array.from({ length: Number(e.payload.size) || 0 }, () => ({})),
    },
  });
}

// Order doesn't matter for correctness (the Worker never lets an older event overwrite a newer
// one), but oldest-first reads naturally in the log.
deliveries.reverse();
console.log(`${deliveries.length} deliveries (${deliveries.filter((d) => d.event === "pull_request").length} PR, ${deliveries.filter((d) => d.event === "push").length} push)`);
if (!send) process.exit(0);

let recorded = 0, ignored = 0, failed = 0;
for (const d of deliveries) {
  const body = JSON.stringify(d.payload);
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const res = await fetch(`${url}/v1/gh`, { method: "POST", body, headers: { "content-type": "application/json", "x-github-event": d.event, "x-github-delivery": d.id, "x-hub-signature-256": sig } });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { failed++; console.error(`${d.id}: HTTP ${res.status} ${JSON.stringify(out)}`); }
  else if (out.recorded) recorded++;
  else ignored++;
}
console.log(`recorded ${recorded}, ignored ${ignored} (duplicate, off-allowlist, or not on roster), failed ${failed}`);
process.exit(failed ? 1 : 0);
