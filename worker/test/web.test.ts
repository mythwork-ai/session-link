import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAuthor, signInWithGithub } from "../src/auth/github";
import { sessionCookie } from "../src/web/session";
import { ADMIN, E, author, call } from "./helpers";
import worker from "../src/index";
import { createExecutionContext } from "cloudflare:test";

async function get(path: string, headers: Record<string, string> = {}, method = "GET") {
  return worker.fetch(new Request(`https://sl.test${path}`, { method, headers, redirect: "manual" }), E, createExecutionContext());
}
const cookieFor = async (login: string) => (await sessionCookie(E, login, Date.now())).split(";")[0]!;

afterEach(() => vi.restoreAllMocks());

describe("web pages", () => {
  it("/feed shows a sign-in page without a valid session, including a forged one", async () => {
    const r = await get("/feed");
    expect(r.status).toBe(401);
    const body = await r.text();
    expect(body).toContain('href="/login?next=%2Ffeed"');
    expect(body).toContain("Sign in with GitHub");
    await author("erin");
    const forged = (await cookieFor("erin")).replace(/\.[^.]+$/, ".AAAA");
    expect((await get("/feed", { cookie: forged })).status).toBe(401);
  });

  it("every page follows the viewer's light or dark setting", async () => {
    const body = await (await get("/feed")).text();
    expect(body).toContain("@media (prefers-color-scheme:dark)");
    expect(body).toContain("color-scheme:light dark");
  });

  it("someone not on the list gets a page naming the admins", async () => {
    await call("POST", "/v1/admin/authors", { headers: ADMIN, body: { id: "erin", display_name: "Erin", role: "admin" } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("access_token")) return Response.json({ access_token: "gho_test" });
      return Response.json({ login: "Stranger", name: "S" });
    });
    const r = await get("/callback/web?state=s1.feed&code=c", { cookie: "__Host-sl-state=s1.feed" });
    expect(r.status).toBe(403);
    const body = await r.text();
    expect(body).toContain("not on the list yet");
    expect(body).toContain("<strong>Erin</strong>");
    expect(body).toContain("stranger");
  });

  it("/feed renders escaped names and hook health", async () => {
    await call("POST", "/v1/admin/authors", { headers: ADMIN, body: { id: "erin", display_name: "<script>x</script>" } });
    const r = await get("/feed", { cookie: await cookieFor("erin") });
    const body = await r.text();
    expect(r.status).toBe(200);
    expect(body).toContain("&#60;script&#62;");
    expect(body).not.toContain("<script>x");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("revoking an author ends their web session", async () => {
    await author("erin");
    const cookie = await cookieFor("erin");
    await call("POST", "/v1/admin/authors/erin/revoke", { headers: ADMIN });
    expect((await get("/feed", { cookie })).status).toBe(401);
  });

  it("/feed.json needs a browser session", async () => {
    await author("erin");
    const cookie = await cookieFor("erin");
    expect(await (await get("/feed.json?author=me", { cookie })).json()).toEqual({ rows: [] });
    expect((await call("GET", "/feed.json")).status).toBe(401);
    expect((await get("/feed.json?since_hours=abc", { cookie })).status).toBe(400);
  });

  it("/login binds a state cookie and sends the user to GitHub with the web callback", async () => {
    const r = await get("/login?next=/feed");
    const loc = new URL(r.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://sl.test/callback/web");
    expect(loc.searchParams.get("scope")).toBe("");
    expect(r.headers.get("set-cookie")).toContain(`__Host-sl-state=${loc.searchParams.get("state")}`);
    const expired = await get("/callback/web?state=other&code=x", { cookie: `__Host-sl-state=${loc.searchParams.get("state")}` });
    expect(expired.status).toBe(400);
    expect(await expired.text()).toContain("That sign-in expired");
  });
});

function stubGithub(name = "Erin <b>Smith</b>\u202e") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/login/oauth/access_token")) return Response.json({ access_token: "gho_test" });
    if (url.endsWith("/user")) return Response.json({ login: "Erin", name });
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe("GitHub sign-in", () => {
  it("returns the identity with a flattened display name and never asks GitHub about orgs", async () => {
    const spy = stubGithub();
    expect(await signInWithGithub(E, "code", "/callback")).toEqual({ login: "erin", name: "Erin ‹b›Smith‹/b›" });
    expect(spy.mock.calls.some(([u]) => String(u).includes("memberships"))).toBe(false);
  });

  it("access is invite-only: on the roster gets in, everyone else and removed people don't", async () => {
    await expect(ensureAuthor(E, { login: "stranger", name: "S" }, Date.now())).rejects.toMatchObject({ status: 403, code: "not_on_roster" });
    expect(await E.LEDGER_DB.prepare("SELECT COUNT(*) AS n FROM authors WHERE id='stranger'").first("n")).toBe(0);
    await author("erin");
    await expect(ensureAuthor(E, { login: "erin", name: "Erin" }, Date.now())).resolves.toBeUndefined();
    await call("POST", "/v1/admin/authors/erin/revoke", { headers: ADMIN });
    await expect(ensureAuthor(E, { login: "erin", name: "Erin" }, Date.now())).rejects.toMatchObject({ code: "author_revoked" });
  });
});
