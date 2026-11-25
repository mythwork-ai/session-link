import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { sessionCookie } from "../src/web/session";
import { ADMIN, E, REPO, author, call, mcp } from "./helpers";

async function page(path: string, login: string) {
  const cookie = (await sessionCookie(E, login, Date.now())).split(";")[0]!;
  const r = await worker.fetch(new Request(`https://sl.test${path}`, { headers: { cookie } }), E, createExecutionContext());
  return r.text();
}

const rows = () => E.LEDGER_DB.prepare("SELECT kind, branch, summary, paths, source, expires_at - updated_at AS ttl FROM updates ORDER BY branch").all<any>().then((r) => r.results);

describe("set_presence", () => {
  it("keeps one summary-free row per person, repo and branch that teammates see in the path map", async () => {
    await author("alex", "Alex");
    await author("sam", "Sam");
    const alex = await mcp("alex");
    expect((await alex("set_presence", { repo_url: REPO, branch: "feat/x", paths: ["src/a.ts"] })).isError).toBe(false);
    await alex("set_presence", { repo_url: REPO, branch: "feat/x", paths: ["src/a.ts", "src/b.ts"] });
    await alex("set_presence", { repo_url: REPO, branch: "feat/y", paths: ["docs/c.md"] });
    expect(await rows()).toEqual([
      { kind: "heartbeat", branch: "feat/x", summary: null, paths: '["src/a.ts","src/b.ts"]', source: "mcp", ttl: 4 * 3_600_000 },
      { kind: "heartbeat", branch: "feat/y", summary: null, paths: '["docs/c.md"]', source: "mcp", ttl: 4 * 3_600_000 },
    ]);

    const sam = await mcp("sam");
    const map = (await sam("read_feed", { repo_url: REPO })).data.map;
    expect(map["src/b.ts"]).toEqual([expect.objectContaining({ author: "alex", branch: "feat/x" })]);
    expect((await sam("who_is_touching", { repo_url: REPO, path: "src/a.ts" })).data.owners).toEqual([expect.objectContaining({ author: "alex" })]);
    // Your own presence never warns you.
    expect((await alex("read_feed", { repo_url: REPO })).data.map).toEqual({});
  });

  it("validates like post_update and needs an editor", async () => {
    await author("alex");
    await author("vic", "Vic", "viewer");
    const alex = await mcp("alex");
    expect((await alex("set_presence", { repo_url: "github.com/other/repo", paths: ["a.ts"] })).isError).toBe(true);
    expect((await alex("set_presence", { repo_url: REPO, paths: ["../etc/passwd"] })).text).toMatch(/repo-relative/);
    expect((await alex("set_presence", { repo_url: REPO, paths: ["AKIAABCDEFGHIJKLMNOP.txt"] })).text).toMatch(/looks like/);
    expect((await (await mcp("vic"))("set_presence", { repo_url: REPO, paths: ["a.ts"] })).isError).toBe(true);
    await call("PUT", "/v1/admin/settings", { headers: ADMIN, body: { kill_switch: true } });
    expect((await alex("set_presence", { repo_url: REPO, paths: ["a.ts"] })).text).toMatch(/paused/);
    expect(await rows()).toEqual([]);
  });

  it("shows on the feed as work in progress", async () => {
    await author("alex", "Alex");
    await author("sam", "Sam");
    await (await mcp("alex"))("set_presence", { repo_url: REPO, branch: "feat/x", paths: ["src/a.ts", "src/b.ts"] });
    const html = await page("/feed", "sam");
    expect(html).toContain(">working</span>");
    expect(html).toContain("Working on feat/x · 2 files");
  });
});

describe("overlap events", () => {
  const overlaps = () => E.LEDGER_DB.prepare("SELECT author_id, detail FROM events WHERE type = 'overlap_detected'").all<any>().then((r) => r.results);

  it("counts each pair once per repo and 4-hour window, and never logs paths", async () => {
    await author("alex");
    await author("sam");
    // One clock for every call, so the 4-hour window can't roll over mid-test.
    const now = Date.now();
    await (await mcp("alex", now))("set_presence", { repo_url: REPO, branch: "feat/x", paths: ["src/auth/session.ts"] });
    const sam = await mcp("sam", now);
    expect((await sam("set_presence", { repo_url: REPO, branch: "feat/y", paths: ["src/auth/session.ts", "README.md"] })).data.overlaps).toBe(1);
    expect((await sam("set_presence", { repo_url: REPO, branch: "feat/y", paths: ["src/auth/session.ts"] })).data.overlaps).toBe(0);
    // The same pair from the other side, through post_update and a directory path, is the same overlap.
    await (await mcp("alex", now))("post_update", { kind: "progress", summary: "Reworking auth", repo_url: REPO, paths: ["src/auth/"] });
    const events = await overlaps();
    expect(events).toHaveLength(1);
    expect(events[0].author_id).toBe("sam");
    const detail = JSON.parse(events[0].detail);
    expect(detail).toMatchObject({ with: "alex", repo: "github.com/acme/app", files: 1 });
    expect(events[0].detail).not.toContain("session.ts");
  });

  it("records nothing when paths don't meet", async () => {
    await author("alex");
    await author("sam");
    await (await mcp("alex"))("set_presence", { repo_url: REPO, paths: ["src/a.ts"] });
    expect((await (await mcp("sam"))("set_presence", { repo_url: REPO, paths: ["src/ab.ts", "src/a.ts.bak"] })).data.overlaps).toBe(0);
    expect(await overlaps()).toEqual([]);
  });
});
