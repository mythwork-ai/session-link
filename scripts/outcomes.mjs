#!/usr/bin/env node
// Team outcomes from GitHub, before and during a session-link trial: how many PRs, how long they
// wait for a first review and to merge, how big they are, and how many open PRs conflict. Usage
// numbers say whether people use the tool; these say whether the team got faster. Read-only; uses
// your `gh` login.
//
//   node scripts/outcomes.mjs --repo acme/app [--repo acme/api] [--before 2026-11-01..2026-11-14] [--during 2026-11-15..2026-11-28]
//   node scripts/outcomes.mjs --org acme
//
// Defaults: "during" is the last 14 days and "before" the 14 days ahead of it, in UTC days. Each
// range is inclusive and matches PRs by creation date. Bot PRs and bot reviews are left out.
// Read with care:
// - Times only count PRs that already got a review or merged, so a recent range looks faster
//   while its slow PRs are still waiting. `no_review` shows how many are left out. Pick a
//   "during" range that ended a week or more ago for a fair comparison.
// - Conflicts are a proxy: GitHub only reports mergeability now, so it is the share of a range's
//   still-open PRs that conflict today, among those GitHub has computed. Older PRs have had longer
//   to fall behind.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const PR_LIMIT = 1000; // GitHub search returns at most this many
const REPO_LIMIT = 500;

const isBot = (a) => !a || a.is_bot === true || /\[bot\]$/.test(a.login ?? "");

export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}

/** Summary numbers for one range. Times in hours; a PR with no review from someone else is left out of review times. */
export function summarize(all) {
  const prs = all.filter((p) => !isBot(p.author));
  const firstReview = [];
  const toMerge = [];
  for (const p of prs) {
    const opened = Date.parse(p.createdAt);
    const others = (p.reviews ?? []).filter((r) => !isBot(r.author) && r.author.login !== p.author.login && r.submittedAt);
    if (others.length) firstReview.push((Math.min(...others.map((r) => Date.parse(r.submittedAt))) - opened) / HOUR);
    if (p.mergedAt) toMerge.push((Date.parse(p.mergedAt) - opened) / HOUR);
  }
  // UNKNOWN means GitHub hasn't computed mergeability yet; it says nothing either way.
  const open = prs.filter((p) => p.state === "OPEN" && p.mergeable !== "UNKNOWN");
  return {
    prs: prs.length,
    merged: toMerge.length,
    no_review: prs.length - firstReview.length,
    review_median_h: quantile(firstReview, 0.5),
    review_p90_h: quantile(firstReview, 0.9),
    merge_median_h: quantile(toMerge, 0.5),
    merge_p90_h: quantile(toMerge, 0.9),
    size_median: quantile(prs.map((p) => p.additions + p.deletions), 0.5),
    open: open.length,
    conflicting_share: open.length ? open.filter((p) => p.mergeable === "CONFLICTING").length / open.length : null,
  };
}

/** "YYYY-MM-DD..YYYY-MM-DD" -> [startMs, endMs) with the end day included. */
export function parseRange(s) {
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(s ?? "");
  if (!m) throw new Error(`bad range "${s}": use YYYY-MM-DD..YYYY-MM-DD`);
  const start = Date.parse(`${m[1]}T00:00:00Z`);
  const end = Date.parse(`${m[2]}T00:00:00Z`) + DAY;
  if (!(end > start)) throw new Error(`range "${s}" ends before it starts`);
  return [start, end];
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const fmt = (k, v) => (v === null ? "n/a" : k === "conflicting_share" ? `${Math.round(v * 100)}%` : k.endsWith("_h") ? `${v.toFixed(1)}h` : String(Math.round(v)));

export function table(before, during) {
  const rows = Object.keys(before).map((k) => [k, fmt(k, before[k]), fmt(k, during[k])]);
  const w = [6, 6, 6].map((n, i) => Math.max(n, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(w[i])).join("  ");
  return [line(["metric", "before", "during"]), line(w.map((n) => "-".repeat(n))), ...rows.map(line)].join("\n");
}

/** --flag value pairs; unknown flags or missing values throw rather than fall back to defaults. */
export function parseArgs(argv) {
  const out = { repo: [], org: [], before: [], during: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    if (!argv[i]?.startsWith("--") || !Object.hasOwn(out, k)) throw new Error(`unknown argument "${argv[i]}"`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error(`${argv[i]} needs a value`);
    out[k].push(argv[i + 1]);
  }
  return out;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nusage: node scripts/outcomes.mjs (--repo owner/name ... | --org name) [--before A..B] [--during A..B]`);
    process.exit(2);
  }
  const all = (name) => opts[name.slice(2)];
  const NAME = /^[A-Za-z0-9._-]+$/;
  const gh = (...a) => JSON.parse(execFileSync("gh", a, { encoding: "utf8", maxBuffer: 64 << 20 }));
  let repos = all("--repo");
  const org = all("--org")[0];
  if (org) {
    if (!NAME.test(org)) throw new Error(`bad org "${org}"`);
    const listed = gh("repo", "list", org, "--no-archived", "--limit", String(REPO_LIMIT), "--json", "nameWithOwner");
    if (listed.length >= REPO_LIMIT) throw new Error(`${org} has ${REPO_LIMIT}+ repos; pass --repo for the ones you want`);
    repos = repos.concat(listed.map((r) => r.nameWithOwner));
  }
  if (!repos.length) {
    console.error("usage: node scripts/outcomes.mjs (--repo owner/name ... | --org name) [--before A..B] [--during A..B]");
    process.exit(2);
  }
  for (const r of repos) if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(r)) throw new Error(`bad repo "${r}"`);
  const today = Date.parse(`${day(Date.now())}T00:00:00Z`);
  const during = all("--during")[0] ? parseRange(all("--during")[0]) : [today - 13 * DAY, today + DAY];
  const before = all("--before")[0] ? parseRange(all("--before")[0]) : [during[0] - 14 * DAY, during[0]];

  // One search per range and repo; stop rather than undercount if GitHub's cap is hit.
  const fetch = ([a, b]) =>
    repos.flatMap((r) => {
      const prs = gh("pr", "list", "-R", r, "--state", "all", "--limit", String(PR_LIMIT), "--search", `created:${day(a)}..${day(b - DAY)}`,
        "--json", "number,author,state,createdAt,mergedAt,additions,deletions,reviews,mergeable");
      if (prs.length >= PR_LIMIT) throw new Error(`${r} has ${PR_LIMIT}+ PRs in ${day(a)}..${day(b - DAY)}; use shorter ranges`);
      return prs;
    });
  console.log(`${repos.length} repo(s). before ${day(before[0])}..${day(before[1] - DAY)}, during ${day(during[0])}..${day(during[1] - DAY)}\n`);
  console.log(table(summarize(fetch(before)), summarize(fetch(during))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
