import type { Env } from "../env";
import { HttpError } from "../http";

const enc = new TextEncoder();

/** Constant-time string compare: hash both sides so lengths always match. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  return crypto.subtle.timingSafeEqual(ha!, hb!);
}

export async function requireAdmin(env: Env, req: Request): Promise<void> {
  if (!env.ADMIN_TOKEN) throw new HttpError(503, "admin_disabled", "ADMIN_TOKEN secret is not set");
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m?.[1]) throw new HttpError(401, "unauthorized", "missing bearer token");
  if (!(await safeEqual(m[1], env.ADMIN_TOKEN))) throw new HttpError(403, "forbidden", "admin token required");
}
