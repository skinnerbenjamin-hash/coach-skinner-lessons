// Admin authentication: phone + password.
// - Password is hashed with scrypt (Node built-in, no native deps).
// - Session is a signed token stored as an HttpOnly cookie; sessions persist in SQLite so
//   they survive server restarts.
// - Default admin is seeded on first boot from constants below; the coach can change it in Settings.

import Database from "better-sqlite3";
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const sqlite = new Database(process.env.DB_PATH || "data.db");
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS admin_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phone TEXT NOT NULL,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    is_owner INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = "csl_admin";

// --- Hashing ---
function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}
function verifyPassword(password: string, salt: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
function normalizePhone(p: string) {
  return (p || "").replace(/\D/g, "");
}

// --- Seed default admin on first boot ---
export function seedDefaultAdmin(phone: string, password: string) {
  const np = normalizePhone(phone);
  const existingLegacy = sqlite.prepare(`SELECT id FROM admin_credentials WHERE id=1`).get();
  if (!existingLegacy) {
    const salt = randomBytes(16).toString("hex");
    const hash = hashPassword(password, salt);
    sqlite.prepare(
      `INSERT INTO admin_credentials (id, phone, salt, hash, updated_at) VALUES (1, ?, ?, ?, ?)`
    ).run(np, salt, hash, Date.now());
    console.log(`[auth] seeded default admin (legacy) for phone ${np}`);
  }
  // Mirror to multi-admin table
  const existingUser = sqlite.prepare(`SELECT id FROM admin_users WHERE phone=?`).get(np);
  if (!existingUser) {
    // Copy the legacy row's salt/hash if available so the same password keeps working
    const legacy = sqlite.prepare(`SELECT salt, hash FROM admin_credentials WHERE id=1`).get() as any;
    let salt = legacy?.salt;
    let hash = legacy?.hash;
    if (!salt || !hash) {
      salt = randomBytes(16).toString("hex");
      hash = hashPassword(password, salt);
    }
    const now = Date.now();
    sqlite.prepare(
      `INSERT INTO admin_users (phone, name, salt, hash, is_owner, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`
    ).run(np, "Coach Skinner", salt, hash, now, now);
    console.log(`[auth] seeded owner admin for phone ${np}`);
  } else {
    // Make sure owner flag is set
    sqlite.prepare(`UPDATE admin_users SET is_owner=1 WHERE phone=?`).run(np);
  }
}

// --- Multi-admin management ---
export type AdminUser = {
  id: number;
  phone: string;
  name: string;
  isOwner: boolean;
  createdAt: number;
  updatedAt: number;
};

function rowToAdminUser(row: any): AdminUser {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    isOwner: !!row.is_owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAdminUsers(): AdminUser[] {
  const rows = sqlite.prepare(`SELECT * FROM admin_users ORDER BY is_owner DESC, created_at ASC`).all() as any[];
  return rows.map(rowToAdminUser);
}

export function addAdminUser(input: { phone: string; name: string; password: string }): AdminUser {
  const np = normalizePhone(input.phone);
  if (!np || np.length < 7) throw new Error("Phone number is required");
  if (!input.password || input.password.length < 6) throw new Error("Password must be at least 6 characters");
  const existing = sqlite.prepare(`SELECT id FROM admin_users WHERE phone=?`).get(np);
  if (existing) throw new Error("An admin with that phone already exists");
  const salt = randomBytes(16).toString("hex");
  const hash = hashPassword(input.password, salt);
  const now = Date.now();
  sqlite.prepare(
    `INSERT INTO admin_users (phone, name, salt, hash, is_owner, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)`
  ).run(np, input.name || "", salt, hash, now, now);
  const row = sqlite.prepare(`SELECT * FROM admin_users WHERE phone=?`).get(np);
  return rowToAdminUser(row);
}

export function deleteAdminUser(id: number) {
  const row = sqlite.prepare(`SELECT * FROM admin_users WHERE id=?`).get(id) as any;
  if (!row) return;
  if (row.is_owner) throw new Error("Cannot remove the owner admin");
  sqlite.prepare(`DELETE FROM admin_users WHERE id=?`).run(id);
}

// --- Credential change ---
export function updateCredentials(opts: { phone?: string; password?: string }) {
  const row = sqlite.prepare(`SELECT * FROM admin_credentials WHERE id=1`).get() as any;
  if (!row) throw new Error("admin not seeded");
  const phone = opts.phone ? normalizePhone(opts.phone) : row.phone;
  let salt = row.salt;
  let hash = row.hash;
  if (opts.password) {
    salt = randomBytes(16).toString("hex");
    hash = hashPassword(opts.password, salt);
  }
  sqlite.prepare(
    `UPDATE admin_credentials SET phone=?, salt=?, hash=?, updated_at=? WHERE id=1`
  ).run(phone, salt, hash, Date.now());
  // invalidate all existing sessions when password changes
  if (opts.password) sqlite.prepare(`DELETE FROM admin_sessions`).run();
}

export function getAdminPhone(): string {
  const row = sqlite.prepare(`SELECT phone FROM admin_credentials WHERE id=1`).get() as any;
  return row?.phone || "";
}

// --- Login / sessions ---
export function checkLogin(phone: string, password: string): { ok: true; token: string } | { ok: false } {
  const np = normalizePhone(phone);
  // First check multi-admin table
  const adminRow = sqlite.prepare(`SELECT * FROM admin_users WHERE phone=?`).get(np) as any;
  let verified = false;
  if (adminRow && verifyPassword(password, adminRow.salt, adminRow.hash)) {
    verified = true;
  } else {
    // Fallback to legacy single-admin table
    const legacy = sqlite.prepare(`SELECT * FROM admin_credentials WHERE id=1`).get() as any;
    if (legacy && np === legacy.phone && verifyPassword(password, legacy.salt, legacy.hash)) {
      verified = true;
    }
  }
  if (!verified) return { ok: false };
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  sqlite.prepare(
    `INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)`
  ).run(token, now, now + SESSION_TTL_MS);
  sqlite.prepare(`DELETE FROM admin_sessions WHERE expires_at < ?`).run(now);
  return { ok: true, token };
}

export function logout(token: string) {
  if (!token) return;
  sqlite.prepare(`DELETE FROM admin_sessions WHERE token=?`).run(token);
}

function isValidSession(token: string): boolean {
  if (!token) return false;
  const row = sqlite.prepare(`SELECT expires_at FROM admin_sessions WHERE token=?`).get(token) as any;
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    sqlite.prepare(`DELETE FROM admin_sessions WHERE token=?`).run(token);
    return false;
  }
  return true;
}

// --- Cookie parsing ---
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    if (k) out[k] = v;
  }
  return out;
}

export function getTokenFromReq(req: Request): string {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[COOKIE_NAME] || "";
}

export function setSessionCookie(res: Response, token: string) {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const isProd = process.env.NODE_ENV === "production";
  const secureFlag = isProd ? "Secure; " : "";
  res.setHeader("Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; ${secureFlag}SameSite=Lax`
  );
}
export function clearSessionCookie(res: Response) {
  const isProd = process.env.NODE_ENV === "production";
  const secureFlag = isProd ? "Secure; " : "";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; ${secureFlag}SameSite=Lax`);
}

// --- Middleware ---
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = getTokenFromReq(req);
  if (!isValidSession(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

export function isAuthed(req: Request): boolean {
  return isValidSession(getTokenFromReq(req));
}
