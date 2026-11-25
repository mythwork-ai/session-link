import type { Env } from "../env";

// Signed cookie for the human pages (/feed, /tokens): "<login>.<expiry>.<hmac>".
const COOKIE = "__Host-sl-session";
const TTL_S = 7 * 24 * 3600;
const enc = new TextEncoder();

async function mac(env: Env, data: string): Promise<string> {
  if (!env.COOKIE_KEY || env.COOKIE_KEY.length < 32) throw new Error("COOKIE_KEY secret must be 32+ chars");
  const key = await crypto.subtle.importKey("raw", enc.encode(env.COOKIE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sessionCookie(env: Env, login: string, now: number): Promise<string> {
  const payload = `${login}.${Math.floor(now / 1000) + TTL_S}`;
  return `${COOKIE}=${payload}.${await mac(env, payload)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${TTL_S}`;
}

export async function readSession(env: Env, req: Request, now: number): Promise<string | null> {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-z0-9-]+)\\.(\\d+)\\.([A-Za-z0-9_-]+)`).exec(req.headers.get("cookie") ?? "");
  if (!m) return null;
  const [, login, exp, sig] = m as unknown as [string, string, string, string];
  if (Number(exp) * 1000 < now) return null;
  const want = await mac(env, `${login}.${exp}`);
  const a = enc.encode(sig);
  const b = enc.encode(want);
  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) return null;
  const revoked = await env.LEDGER_DB.prepare("SELECT revoked_at FROM authors WHERE id = ?").bind(login).first<{ revoked_at: number | null }>();
  return revoked && !revoked.revoked_at ? login : null;
}

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
