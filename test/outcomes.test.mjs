// Stats helpers behind scripts/outcomes.mjs. Run with: node --test test/outcomes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, parseRange, quantile, summarize, table } from "../scripts/outcomes.mjs";

test("quantile interpolates and handles empty input", () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([5], 0.9), 5);
  assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
});

const pr = (over) => ({ author: { login: "sam" }, state: "MERGED", createdAt: "2026-11-01T00:00:00Z", mergedAt: null, additions: 10, deletions: 0, reviews: [], mergeable: "UNKNOWN", ...over });

test("summarize ignores self-reviews and times merges and first reviews in hours", () => {
  const s = summarize([
    pr({ mergedAt: "2026-11-01T10:00:00Z", reviews: [{ author: { login: "sam" }, submittedAt: "2026-11-01T01:00:00Z" }, { author: { login: "alex" }, submittedAt: "2026-11-01T04:00:00Z" }, { author: { login: "pat" }, submittedAt: "2026-11-01T02:00:00Z" }] }),
    pr({ mergedAt: "2026-11-02T00:00:00Z", additions: 30, deletions: 20 }),
    pr({ state: "OPEN", mergeable: "CONFLICTING" }),
    pr({ state: "OPEN", mergeable: "MERGEABLE" }),
  ]);
  assert.equal(s.prs, 4);
  assert.equal(s.merged, 2);
  assert.equal(s.review_median_h, 2, "pat's review at 2h, not sam's own at 1h");
  assert.equal(s.merge_median_h, 17);
  assert.equal(s.size_median, 10);
  assert.equal(s.conflicting_share, 0.5);
  assert.equal(summarize([]).conflicting_share, null);
});

test("parseRange includes the end day and rejects bad input", () => {
  const [a, b] = parseRange("2026-11-01..2026-11-14");
  assert.equal(b - a, 14 * 86_400_000);
  assert.throws(() => parseRange("2026-11-14..2026-11-01"), /ends before/);
  assert.throws(() => parseRange("last week"), /bad range/);
});

test("table prints n/a for missing numbers", () => {
  const out = table(summarize([]), summarize([pr({ mergedAt: "2026-11-01T05:00:00Z" })]));
  assert.match(out, /merge_median_h\s+n\/a\s+5\.0h/);
  assert.match(out, /conflicting_share\s+n\/a\s+n\/a/);
});

test("bots are left out, and unknown mergeability doesn't count as clean", () => {
  const s = summarize([
    pr({ author: { login: "dependabot[bot]" }, additions: 999 }),
    pr({ reviews: [{ author: { login: "copilot-reviewer[bot]" }, submittedAt: "2026-11-01T00:01:00Z" }, { author: { login: "alex", is_bot: false }, submittedAt: "2026-11-01T06:00:00Z" }] }),
    pr({ reviews: [{ author: { login: "ci", is_bot: true }, submittedAt: "2026-11-01T00:01:00Z" }] }),
    pr({ state: "OPEN", mergeable: "UNKNOWN" }),
    pr({ state: "OPEN", mergeable: "CONFLICTING" }),
  ]);
  assert.equal(s.prs, 4);
  assert.equal(s.review_median_h, 6);
  assert.equal(s.review_p90_h, 6);
  assert.equal(s.no_review, 3);
  assert.equal(s.open, 1);
  assert.equal(s.conflicting_share, 1);
  assert.equal(s.size_median, 10);
});

test("parseArgs collects repeated flags and refuses typos and missing values", () => {
  assert.deepEqual(parseArgs(["--repo", "a/b", "--repo", "c/d", "--during", "2026-11-01..2026-11-02"]), { repo: ["a/b", "c/d"], org: [], before: [], during: ["2026-11-01..2026-11-02"] });
  assert.throws(() => parseArgs(["--duing", "x"]), /unknown argument/);
  assert.throws(() => parseArgs(["--during"]), /needs a value/);
  assert.throws(() => parseArgs(["--repo", "--org", "x"]), /needs a value/);
});
