import type { Env } from "../env";
import { HttpError } from "../http";

export type Role = "viewer" | "editor" | "admin";
const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };
export const ROLES: Role[] = ["viewer", "editor", "admin"];

/** The active role of a login, or null if they're not on the roster or have been removed. */
export async function getRole(env: Env, login: string): Promise<Role | null> {
  const row = await env.LEDGER_DB.prepare("SELECT role FROM authors WHERE id = ? AND revoked_at IS NULL").bind(login).first<{ role: Role }>();
  return row?.role ?? null;
}

/**
 * Operators (the OPERATORS secret, comma-separated logins) can manage access without being
 * shown as admins: their visible role stays whatever the roster says. They must still be on
 * the roster and not removed.
 */
export function isOperator(env: Env, login: string): boolean {
  return (env.OPERATORS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).includes(login.toLowerCase());
}

/** Whether a login may manage access: an admin, or an operator who is still on the roster. */
export async function canManage(env: Env, login: string): Promise<boolean> {
  const role = await getRole(env, login);
  return role === "admin" || (role !== null && isOperator(env, login));
}

export async function requireRole(env: Env, login: string, needed: Role): Promise<Role> {
  const role = await getRole(env, login);
  if (!role) throw new HttpError(403, "no_access", "you don't have access to session-link; ask an admin to add you");
  if (needed === "admin" && isOperator(env, login)) return role;
  if (RANK[role] < RANK[needed]) throw new HttpError(403, "read_only", `your role is ${role}; ${needed} access is needed for this. Ask an admin to change it.`);
  return role;
}
