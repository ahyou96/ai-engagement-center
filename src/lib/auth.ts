import crypto from "node:crypto";
import { cookies } from "next/headers";
import { one, run } from "./db";
import { can, Permission } from "./rbac";
import { HttpError, nowIso } from "./util";
import { Actor } from "./audit";

export type SessionUser = { id: string; email: string; name: string; role_id: string; org_id: string; language: string };
const COOKIE = "aec_session";

export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string) {
  const [salt, h] = stored.split(":");
  const calc = crypto.scryptSync(pw, salt, 32);
  return crypto.timingSafeEqual(calc, Buffer.from(h, "hex"));
}

export async function login(email: string, password: string) {
  const u = one<SessionUser & { password_hash: string; status: string }>("SELECT * FROM users WHERE email = ?", email.toLowerCase().trim());
  if (!u || u.status !== "active" || !verifyPassword(password, u.password_hash)) return null;
  const sid = crypto.randomBytes(24).toString("hex");
  run("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)", sid, u.id, nowIso(), new Date(Date.now() + 12 * 3600_000).toISOString());
  (await cookies()).set(COOKIE, sid, { httpOnly: true, path: "/", maxAge: 12 * 3600,
    // AEC_EMBED_ORIGIN (e.g. Hugging Face Spaces) renders the app in a cross-site iframe: the cookie must then be SameSite=None; Secure.
    ...(process.env.AEC_EMBED_ORIGIN ? { sameSite: "none" as const, secure: true, partitioned: true } : { sameSite: "lax" as const, secure: process.env.NODE_ENV === "production" && process.env.AEC_INSECURE_COOKIE !== "1" }) });
  return u;
}

export async function logout() {
  const c = await cookies();
  const sid = c.get(COOKIE)?.value;
  if (sid) run("DELETE FROM sessions WHERE id = ?", sid);
  c.delete(COOKIE);
}

export async function currentUser(): Promise<SessionUser | null> {
  const sid = (await cookies()).get(COOKIE)?.value;
  if (!sid) return null;
  const u = one<SessionUser>(
    "SELECT u.id, u.email, u.name, u.role_id, u.org_id, u.language FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND u.status = 'active'",
    sid, new Date().toISOString()
  );
  return u ?? null;
}

export async function requireUser(perm?: Permission): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) throw new HttpError(401, "Not authenticated");
  if (perm && !can(u.role_id, perm)) throw new HttpError(403, `Missing permission: ${perm}`);
  return u;
}

export const actorOf = (u: SessionUser): Actor => ({ type: "user", id: u.email });
