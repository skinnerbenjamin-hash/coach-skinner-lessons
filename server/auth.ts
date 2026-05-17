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
    phone TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    is_owner INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- Tenant-scoped uniqueness on (tenant_id, phone) is added by migrations.ts
  -- AFTER it adds the tenant_id column. We can't create the index here at
  -- module-load time because tenant_id may not exist yet on a fresh install.
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
// The default admin is always for tenant 1 (Coach Skinner). Other tenants
// seed their owner admin via the signup flow, not this function.
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
  // Mirror to multi-admin table — tenant 1 only.
  const existingUser = sqlite.prepare(`SELECT id FROM admin_users WHERE phone=? AND tenant_id=1`).get(np);
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
      `INSERT INTO admin_users (tenant_id, phone, name, salt, hash, is_owner, created_at, updated_at) VALUES (1, ?, ?, ?, ?, 1, ?, ?)`
    ).run(np, "Coach Skinner", salt, hash, now, now);
    console.log(`[auth] seeded owner admin for phone ${np}`);
  } else {
    // Make sure owner flag is set on the tenant-1 row.
    sqlite.prepare(`UPDATE admin_users SET is_owner=1 WHERE phone=? AND tenant_id=1`).run(np);
  }
}

// --- Multi-admin management ---
export type AdminUser = {
  id: number;
  phone: string;
  name: string;
  email: string;
  givesLessons: boolean;
  receivesEmails: boolean;
  color: string;
  isOwner: boolean;
  createdAt: number;
  updatedAt: number;
};

const ADMIN_PALETTE = [
  "#0ea5e9", "#f97316", "#10b981", "#a855f7", "#ec4899", "#eab308",
  "#06b6d4", "#84cc16", "#ef4444", "#8b5cf6", "#14b8a6", "#f59e0b",
];

function rowToAdminUser(row: any): AdminUser {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    email: row.email || "",
    givesLessons: !!row.gives_lessons,
    receivesEmails: !!row.receives_emails,
    color: row.color || "",
    isOwner: !!row.is_owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function listAdminUsers(tenantId: number): AdminUser[] {
  const rows = sqlite
    .prepare(`SELECT * FROM admin_users WHERE tenant_id=? ORDER BY is_owner DESC, created_at ASC`)
    .all(tenantId) as any[];
  return rows.map(rowToAdminUser);
}

export function addAdminUser(tenantId: number, input: { phone: string; name: string; email: string; password: string; givesLessons?: boolean; receivesEmails?: boolean }): AdminUser {
  const np = normalizePhone(input.phone);
  if (!np || np.length < 7) throw new Error("Phone number is required");
  const emailVal = (input.email || "").trim();
  if (!emailVal) throw new Error("Email is required");
  if (!EMAIL_RE.test(emailVal)) throw new Error("Enter a valid email address");
  if (!input.password || input.password.length < 6) throw new Error("Password must be at least 6 characters");
  const existing = sqlite.prepare(`SELECT id FROM admin_users WHERE phone=? AND tenant_id=?`).get(np, tenantId);
  if (existing) throw new Error("An admin with that phone already exists");
  const salt = randomBytes(16).toString("hex");
  const hash = hashPassword(input.password, salt);
  const now = Date.now();
  const givesLessons = input.givesLessons ? 1 : 0;
  const receivesEmails = input.receivesEmails ? 1 : 0;
  sqlite.prepare(
    `INSERT INTO admin_users (tenant_id, phone, name, email, salt, hash, gives_lessons, receives_emails, color, is_owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?)`
  ).run(tenantId, np, input.name || "", emailVal, salt, hash, givesLessons, receivesEmails, now, now);
  const row = sqlite.prepare(`SELECT * FROM admin_users WHERE phone=? AND tenant_id=?`).get(np, tenantId) as any;
  // Assign color from palette based on row id
  const color = ADMIN_PALETTE[row.id % ADMIN_PALETTE.length];
  sqlite.prepare(`UPDATE admin_users SET color=? WHERE id=?`).run(color, row.id);
  const updatedRow = sqlite.prepare(`SELECT * FROM admin_users WHERE id=?`).get(row.id);
  return rowToAdminUser(updatedRow);
}

export function deleteAdminUser(tenantId: number, id: number) {
  const row = sqlite.prepare(`SELECT * FROM admin_users WHERE id=? AND tenant_id=?`).get(id, tenantId) as any;
  if (!row) return;
  if (row.is_owner) throw new Error("Cannot remove the owner admin");
  sqlite.prepare(`DELETE FROM admin_users WHERE id=? AND tenant_id=?`).run(id, tenantId);
}

export function updateAdminUser(
  tenantId: number,
  id: number,
  patch: { name?: string; email?: string; givesLessons?: boolean; receivesEmails?: boolean; color?: string; password?: string }
): AdminUser {
  const row = sqlite.prepare(`SELECT * FROM admin_users WHERE id=? AND tenant_id=?`).get(id, tenantId) as any;
  if (!row) throw new Error("Admin not found");

  const updates: string[] = [];
  const params: any[] = [];

  if (patch.name !== undefined) {
    updates.push("name=?"); params.push((patch.name || "").trim());
  }
  if (patch.email !== undefined) {
    const emailVal = (patch.email || "").trim();
    if (emailVal && !EMAIL_RE.test(emailVal)) throw new Error("Enter a valid email address");
    updates.push("email=?"); params.push(emailVal);
  }
  if (patch.givesLessons !== undefined) {
    // Owner cannot have gives_lessons flipped to 0
    const val = row.is_owner ? 1 : (patch.givesLessons ? 1 : 0);
    updates.push("gives_lessons=?"); params.push(val);
  }
  if (patch.receivesEmails !== undefined) {
    // Owner cannot have receives_emails flipped to 0
    const val = row.is_owner ? 1 : (patch.receivesEmails ? 1 : 0);
    updates.push("receives_emails=?"); params.push(val);
  }
  if (patch.color !== undefined) {
    updates.push("color=?"); params.push(patch.color || "");
  }
  if (patch.password !== undefined) {
    if (patch.password.length < 6) throw new Error("Password must be at least 6 characters");
    const salt = randomBytes(16).toString("hex");
    const hash = hashPassword(patch.password, salt);
    updates.push("salt=?", "hash=?"); params.push(salt, hash);
    // Delete all sessions for this tenant (force re-login)
    sqlite.prepare(`DELETE FROM admin_sessions WHERE tenant_id=?`).run(tenantId);
  }

  if (updates.length > 0) {
    updates.push("updated_at=?"); params.push(Date.now());
    params.push(id, tenantId);
    sqlite.prepare(`UPDATE admin_users SET ${updates.join(", ")} WHERE id=? AND tenant_id=?`).run(...params);
  }

  const updated = sqlite.prepare(`SELECT * FROM admin_users WHERE id=? AND tenant_id=?`).get(id, tenantId);
  return rowToAdminUser(updated);
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

// --- Password reset (forgot-password) ---
// We issue a single-use, 1-hour reset token. The plaintext token goes only
// into the email link; we store SHA-256(token) in the DB so a leaked DB
// can't be used to forge resets. Token format: 32 bytes hex (64 chars).
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function sha256Hex(s: string): string {
  const h = createHmac("sha256", "lessonspot-reset").update(s).digest("hex");
  return h;
}

// Look up an admin user (multi-admin table) by tenant + (phone OR email).
// We accept either so the user can recover without remembering which they
// used. Returns the row or null.
function findAdminForReset(tenantId: number, identifier: string): { id: number; tenant_id: number; phone: string; email: string } | null {
  const ident = (identifier || "").trim();
  if (!ident) return null;
  // Try as phone first (digits-only match).
  const np = normalizePhone(ident);
  if (np && np.length >= 7) {
    const row = sqlite.prepare(
      `SELECT id, tenant_id, phone, email FROM admin_users WHERE tenant_id=? AND phone=?`
    ).get(tenantId, np) as any;
    if (row) return row;
  }
  // Try as email — match against the admin's own email column (case-insensitive).
  if (ident.includes("@")) {
    const row = sqlite.prepare(
      `SELECT id, tenant_id, phone, email FROM admin_users WHERE tenant_id=? AND lower(email)=lower(?)`
    ).get(tenantId, ident) as any;
    if (row) return row;
    // Fallback: match the tenant's contact_email and return the owner admin.
    const tenantRow = sqlite.prepare(
      `SELECT id, contact_email FROM tenants WHERE id=?`
    ).get(tenantId) as any;
    if (tenantRow && String(tenantRow.contact_email || "").toLowerCase() === ident.toLowerCase()) {
      const owner = sqlite.prepare(
        `SELECT id, tenant_id, phone, email FROM admin_users WHERE tenant_id=? AND is_owner=1 LIMIT 1`
      ).get(tenantId) as any;
      if (owner) return owner;
    }
  }
  return null;
}

// Create a reset token for the given admin and return the plaintext token.
// Invalidates any previous unused tokens for that admin (only the newest is
// usable, so re-clicking "Forgot password" can't pile up valid tokens).
export function createResetToken(tenantId: number, identifier: string): { token: string; adminUserId: number; phone: string; email: string } | null {
  const admin = findAdminForReset(tenantId, identifier);
  if (!admin) return null;
  // Invalidate older unused tokens for this admin.
  sqlite.prepare(
    `UPDATE password_reset_tokens SET used_at=? WHERE admin_user_id=? AND used_at IS NULL`
  ).run(Date.now(), admin.id);
  const token = randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(token);
  const now = Date.now();
  sqlite.prepare(
    `INSERT INTO password_reset_tokens (tenant_id, admin_user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).run(admin.tenant_id, admin.id, tokenHash, now, now + RESET_TOKEN_TTL_MS);
  return { token, adminUserId: admin.id, phone: admin.phone, email: admin.email || "" };
}

// Consume a reset token and set a new password. Returns true on success,
// false if the token is invalid/expired/used or the new password is too short.
export function consumeResetToken(token: string, newPassword: string): { ok: true; tenantId: number; phone: string } | { ok: false; error: string } {
  if (!token || typeof token !== "string") return { ok: false, error: "Invalid link." };
  if (!newPassword || newPassword.length < 6) return { ok: false, error: "Password must be at least 6 characters." };
  const tokenHash = sha256Hex(token);
  const row = sqlite.prepare(
    `SELECT id, tenant_id, admin_user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash=?`
  ).get(tokenHash) as any;
  if (!row) return { ok: false, error: "This reset link is invalid or has already been used." };
  if (row.used_at) return { ok: false, error: "This reset link has already been used." };
  if (row.expires_at < Date.now()) return { ok: false, error: "This reset link has expired. Please request a new one." };
  // Update the admin's password.
  const salt = randomBytes(16).toString("hex");
  const hash = hashPassword(newPassword, salt);
  const now = Date.now();
  const adminRow = sqlite.prepare(
    `SELECT phone, tenant_id, is_owner FROM admin_users WHERE id=?`
  ).get(row.admin_user_id) as any;
  if (!adminRow) return { ok: false, error: "Account not found." };
  sqlite.prepare(
    `UPDATE admin_users SET salt=?, hash=?, updated_at=? WHERE id=?`
  ).run(salt, hash, now, row.admin_user_id);
  // Also keep the legacy admin_credentials row in sync when this is the
  // tenant-1 owner (so the old single-admin login path still works).
  if (adminRow.tenant_id === 1 && adminRow.is_owner) {
    sqlite.prepare(
      `UPDATE admin_credentials SET salt=?, hash=?, updated_at=? WHERE id=1`
    ).run(salt, hash, now);
  }
  // Mark token used.
  sqlite.prepare(
    `UPDATE password_reset_tokens SET used_at=? WHERE id=?`
  ).run(now, row.id);
  // Invalidate ALL existing sessions for this admin's tenant (forces re-login).
  sqlite.prepare(`DELETE FROM admin_sessions WHERE tenant_id=?`).run(adminRow.tenant_id);
  return { ok: true, tenantId: adminRow.tenant_id, phone: adminRow.phone };
}

// --- Login / sessions ---
// tenantId is the host-resolved tenant; we only let an admin log in to their
// own tenant (so a Skinner admin hitting demo.lessonspot.app cannot become an
// admin there).  Legacy single-admin row is always tenant 1.
export function checkLogin(phone: string, password: string, tenantId: number): { ok: true; token: string } | { ok: false } {
  const np = normalizePhone(phone);
  let verified = false;
  let resolvedTenant: number | null = null;
  // First check multi-admin table — must match the current tenant.
  const adminRow = sqlite.prepare(`SELECT * FROM admin_users WHERE phone=? AND tenant_id=?`).get(np, tenantId) as any;
  if (adminRow && verifyPassword(password, adminRow.salt, adminRow.hash)) {
    verified = true;
    resolvedTenant = adminRow.tenant_id;
  } else {
    // Fallback to legacy single-admin table — only valid for tenant 1.
    if (tenantId === 1) {
      const legacy = sqlite.prepare(`SELECT * FROM admin_credentials WHERE id=1`).get() as any;
      if (legacy && np === legacy.phone && verifyPassword(password, legacy.salt, legacy.hash)) {
        verified = true;
        resolvedTenant = 1;
      }
    }
  }
  if (!verified || resolvedTenant === null) return { ok: false };
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  sqlite.prepare(
    `INSERT INTO admin_sessions (token, created_at, expires_at, tenant_id) VALUES (?, ?, ?, ?)`
  ).run(token, now, now + SESSION_TTL_MS, resolvedTenant);
  sqlite.prepare(`DELETE FROM admin_sessions WHERE expires_at < ?`).run(now);
  return { ok: true, token };
}

// Returns the tenant_id bound to a session token, or null if invalid.
export function getSessionTenantId(token: string): number | null {
  if (!token) return null;
  const row = sqlite.prepare(`SELECT expires_at, tenant_id FROM admin_sessions WHERE token=?`).get(token) as any;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    sqlite.prepare(`DELETE FROM admin_sessions WHERE token=?`).run(token);
    return null;
  }
  return row.tenant_id as number;
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
// requireAdmin now ALSO checks that the session's tenant matches the
// host-resolved tenant.  Without this, an admin token from one tenant could
// be used against another tenant's admin endpoints.
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = getTokenFromReq(req);
  const sessTenant = getSessionTenantId(token);
  if (sessTenant === null) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const hostTenant = req.tenantId;
  if (typeof hostTenant === "number" && hostTenant !== sessTenant) {
    return res.status(403).json({ error: "Wrong tenant" });
  }
  next();
}

export function isAuthed(req: Request): boolean {
  const token = getTokenFromReq(req);
  const sessTenant = getSessionTenantId(token);
  if (sessTenant === null) return false;
  const hostTenant = req.tenantId;
  if (typeof hostTenant === "number" && hostTenant !== sessTenant) return false;
  return true;
}
