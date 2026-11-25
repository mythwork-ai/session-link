import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { PR_CONTEXT_MAX } from "../src/pr-context";
import { sessionCookie } from "../src/web/session";
import { E, REPO, author, mcp, post } from "./helpers";

async function page(path: string, login: string) {
  const cookie = (await sessionCookie(E, login, Date.now())).split(";")[0]!;
  const r = await worker.fetch(new Request(`https://sl.test${path}`, { headers: { cookie } }), E, createExecutionContext());
  return r.text();
}

const BODY = "## What it is\nRetries for billing webhooks.\n## How it works\nFive attempts with backoff, then a dead-letter queue.";
const HANDOFF = "## Goal\nFinish retries.\n## Done\nBackoff.\n## Remaining\nDead-letter queue.\n## Branch/PR\nfeat/retries";

describe("pr_context", () => {
  it("is empty when nothing applies", async () => {
    await author("sam");
    expect((await (await mcp("sam"))("pr_context", { repo_url: REPO, branch: "feat/none" })).data.context).toBe("");
    expect(await E.LEDGER_DB.prepare("SELECT detail FROM events WHERE type = 'pr_context_served'").first("detail")).toBe('{"empty":true}');
  });

  it("collects your branch posts, overlapping decisions and knowledge, and handoffs, but not notes to yourself", async () => {
    await author("sam", "Sam");
    await author("alex", "Alex");
    await author("pat", "Pat");
    await post("sam", { kind: "progress", summary: "Retries now back off exponentially", branch: "feat/retries", paths: ["src/billing/"] });
    await post("sam", { kind: "progress", summary: "Other branch work", branch: "feat/other", paths: ["src/other.ts"] });
    await post("alex", { kind: "decision", summary: "Five attempts, matching the provider", branch: "main", paths: ["src/billing/retry.ts"] });
    await post("alex", { kind: "decision", summary: "Docs move to mkdocs", branch: "main", paths: ["docs/"] });
    const k = await (await mcp("pat"))("save_knowledge", { title: "Billing webhook retries", body: BODY, repo_url: REPO, paths: ["src/billing/retry.ts"] });
    const h = await (await mcp("pat"))("create_handoff", { to: "sam", title: "Retries half done", body: HANDOFF, repo_url: REPO, branch: "feat/retries" });
    const sam = await mcp("sam");
    await sam("create_handoff", { to: "me", title: "Private scratch note", body: HANDOFF, repo_url: REPO, branch: "feat/retries" });

    const ctx: string = (await sam("pr_context", { repo_url: REPO, branch: "feat/retries" })).data.context;
    expect(ctx).toContain("Update: Retries now back off exponentially");
    expect(ctx).toContain("Decision by Alex: Five attempts, matching the provider");
    expect(ctx).toContain(`[Billing webhook retries](https://sl.test/notes/${k.data.saved})`);
    expect(ctx).toContain(`Handoff from Pat: [Retries half done](https://sl.test/notes/${h.data.handed_off})`);
    expect(ctx).not.toMatch(/Other branch|mkdocs|Private scratch/);
  });

  it("stays under the cap and rejects odd branches", async () => {
    await author("sam");
    await author("alex", "Alex");
    await post("sam", { branch: "feat/big", paths: ["src/"] });
    for (let i = 0; i < 40; i++) await post("alex", { kind: "decision", summary: `Decision number ${i} about how the source tree is laid out and why`, paths: [`src/f${i}.ts`] });
    const sam = await mcp("sam");
    const ctx: string = (await sam("pr_context", { repo_url: REPO, branch: "feat/big" })).data.context;
    expect(ctx.length).toBeLessThanOrEqual(PR_CONTEXT_MAX);
    expect(ctx.split("\n").length).toBeGreaterThan(5);
    expect((await sam("pr_context", { repo_url: REPO, branch: "a b" })).isError).toBe(true);
  });
});

describe("knowledge_paths", () => {
  it("read_feed indexes the repo's knowledge notes by the paths they cover", async () => {
    await author("pat");
    const pat = await mcp("pat");
    const k = await pat("save_knowledge", { title: "Billing webhook retries", body: BODY, repo_url: REPO, paths: ["src/billing/", "src/billing/retry.ts"] });
    await pat("save_knowledge", { title: "No paths", body: BODY, repo_url: REPO });
    const kp = (await pat("read_feed", { repo_url: REPO })).data.knowledge_paths;
    expect(kp).toEqual({ "src/billing/": [{ id: k.data.saved, title: "Billing webhook retries" }], "src/billing/retry.ts": [{ id: k.data.saved, title: "Billing webhook retries" }] });
  });
});

describe("notes to yourself", () => {
  it("to: me saves a 14-day note that shows as where you left off", async () => {
    await author("sam", "Sam");
    const sam = await mcp("sam");
    const r = await sam("create_handoff", { to: "me", title: "Halfway through retries", body: HANDOFF, repo_url: REPO, branch: "feat/retries" });
    const id = r.data.saved_for_later;
    expect(id).toBeTruthy();
    const ttl = await E.LEDGER_DB.prepare("SELECT expires_at - created_at AS t FROM notes WHERE id = ?").bind(id).first<number>("t");
    expect(ttl).toBe(14 * 86_400_000);
    expect((await sam("read_feed", { repo_url: REPO })).data.handoffs_for_you).toEqual([expect.objectContaining({ id, self: true, title: "Halfway through retries" })]);
    expect(await E.LEDGER_DB.prepare("SELECT detail FROM events WHERE type = 'handoff_created'").first("detail")).toBe('{"to":"sam","self":true}');

    const feed = await page("/feed", "sam");
    expect(feed).toContain("Where you left off");
    expect(feed).not.toContain("handed you");
    const note = await page(`/notes/${id}`, "sam");
    expect(note).toContain("Note to yourself");
    expect(note).toContain("Mark picked up");
  });
});

describe("review fixes", () => {
  it("escapes markdown in teammate text so it can't add links or images to a PR", async () => {
    await author("sam");
    await author("alex", "Alex");
    await post("sam", { branch: "feat/m", paths: ["src/"] });
    await post("alex", { kind: "decision", summary: "see ![x](https://evil.test/p.png) and [docs](https://evil.test)", paths: ["src/a.ts"] });
    const ctx: string = (await (await mcp("sam"))("pr_context", { repo_url: REPO, branch: "feat/m" })).data.context;
    expect(ctx).toContain("\\!\\[x\\]\\(https://evil.test/p.png\\)");
    expect(ctx).not.toMatch(/[^\\]\[docs\]/);
  });

  it("notes to yourself never crowd real handoffs out of the list", async () => {
    await author("sam");
    await author("pat", "Pat");
    const sam = await mcp("sam");
    const h = await (await mcp("pat"))("create_handoff", { to: "sam", title: "Real handoff", body: HANDOFF, repo_url: REPO });
    for (let i = 0; i < 16; i++) await sam("create_handoff", { to: "me", title: `Scratch ${i}`, body: HANDOFF, repo_url: REPO, client_id: `s${i}` });
    const list = (await sam("read_feed", { repo_url: REPO })).data.handoffs_for_you;
    expect(list[0].id).toBe(h.data.handed_off);
    expect(list).toHaveLength(15);
  });
});
