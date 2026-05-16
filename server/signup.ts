// Self-serve signup: creates a new tenant + owner admin in one shot.
//
// Flow:
//   1. POST /api/signup/check-slug   { slug } -> { available: bool, reason?: string }
//   2. POST /api/signup              { name, slug, email, phone, password, sport? }
//      -> creates tenant (plan=trial, trial_ends_at=+14d), seeds default lesson
//         types + a basic Mon-Fri 6pm-8pm availability stub, creates the owner
//         admin in admin_users, returns the subdomain URL and login cookie so
//         the caller can redirect.
//
// Validation rules:
//   - slug: 3-30 chars, lowercase letters/digits/hyphens, no leading/trailing
//     hyphen, not in reserved list (www, app, api, admin, signup, login).
//   - name: 2-80 chars.
//   - email: standard email shape.
//   - phone: 7+ digits after normalization.
//   - password: 8+ chars.
//
// This module is intentionally self-contained: it owns its own SQLite prep
// statements and pulls the password hashing helpers from auth.ts.

import Database from "better-sqlite3";
import { randomBytes, scryptSync } from "node:crypto";

const sqlite = new Database(process.env.DB_PATH || "data.db");

const RESERVED_SLUGS = new Set<string>([
  "www", "app", "api", "admin", "signup", "login", "logout",
  "marketing", "support", "help", "blog", "docs", "status",
  "auth", "static", "assets", "uploads", "favicon",
  "lessonspot", "mail", "smtp", "ftp",
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

export type SlugCheck =
  | { available: true }
  | { available: false; reason: string };

export function checkSlug(slug: string): SlugCheck {
  const s = (slug || "").trim().toLowerCase();
  if (!s) return { available: false, reason: "Pick a subdomain" };
  if (s.length < 3) return { available: false, reason: "At least 3 characters" };
  if (s.length > 30) return { available: false, reason: "30 characters max" };
  if (!SLUG_RE.test(s)) {
    return { available: false, reason: "Letters, numbers and hyphens only" };
  }
  if (RESERVED_SLUGS.has(s)) {
    return { available: false, reason: "That subdomain is reserved" };
  }
  const existing = sqlite
    .prepare(`SELECT id FROM tenants WHERE slug = ? LIMIT 1`)
    .get(s);
  if (existing) return { available: false, reason: "That subdomain is taken" };
  return { available: true };
}

function normalizePhone(p: string): string {
  return (p || "").replace(/\D/g, "");
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SignupInput = {
  name: string;
  slug: string;
  email: string;
  phone: string;
  password: string;
  sport?: string;
};

export type SignupResult =
  | { ok: true; tenantId: number; slug: string; sessionToken: string; trialEndsAt: number }
  | { ok: false; error: string; field?: "name" | "slug" | "email" | "phone" | "password" };

const TRIAL_DAYS = 14;

export function createTenantAndOwner(input: SignupInput): SignupResult {
  const name = (input.name || "").trim();
  const slug = (input.slug || "").trim().toLowerCase();
  const email = (input.email || "").trim().toLowerCase();
  const phone = normalizePhone(input.phone);
  const password = input.password || "";
  const sport = (input.sport || "softball").trim().toLowerCase();

  // ---- Validate ----
  if (name.length < 2 || name.length > 80) {
    return { ok: false, error: "Business name must be 2-80 characters", field: "name" };
  }
  const slugCheck = checkSlug(slug);
  if (!slugCheck.available) {
    return { ok: false, error: slugCheck.reason, field: "slug" };
  }
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "Enter a valid email", field: "email" };
  }
  if (phone.length < 7) {
    return { ok: false, error: "Enter a valid phone number", field: "phone" };
  }
  if (password.length < 8) {
    return { ok: false, error: "Password must be at least 8 characters", field: "password" };
  }

  const now = Date.now();
  const trialEndsAt = now + TRIAL_DAYS * 24 * 60 * 60 * 1000;

  // ---- Transaction: tenant + owner admin + seed lesson types + seed availability ----
  // We do everything inside one transaction so a partial signup never leaves
  // an orphan tenant row behind.
  const tx = sqlite.transaction(() => {
    // Phone uniqueness within the new tenant is implicit (first row).  We
    // intentionally allow the same phone to own multiple tenants -- that's a
    // legitimate use case (a coach with multiple businesses).

    // 1. Create the tenant row.  We rely on the table's default values for
    //    branding fields; the coach can fill those in via the Admin UI.
    const tenantInsert = sqlite.prepare(`
      INSERT INTO tenants (
        slug, name, custom_domain, timezone, active, sport,
        primary_color, logo_path, hero_path, tagline, about,
        contact_phone, contact_email, contact_location,
        booker_label, attendee_label, plan, trial_ends_at, created_at
      ) VALUES (
        ?, ?, NULL, 'America/Indiana/Indianapolis', 1, ?,
        '#0ea5e9', '', '', '', '',
        ?, ?, '',
        'Parent', 'Player', 'trial', ?, ?
      )
    `);
    const tenantResult = tenantInsert.run(slug, name, sport, phone, email, trialEndsAt, now);
    const tenantId = Number(tenantResult.lastInsertRowid);

    // 2. Owner admin user.
    const salt = randomBytes(16).toString("hex");
    const hash = hashPassword(password, salt);
    sqlite.prepare(`
      INSERT INTO admin_users (tenant_id, phone, name, salt, hash, is_owner, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(tenantId, phone, name, salt, hash, now, now);

    // 3. Seed 3 default lesson types so the booking page has something to show
    //    immediately.  The coach can rename/disable/add more via Admin.
    const ltInsert = sqlite.prepare(`
      INSERT INTO lesson_types (tenant_id, name, duration_min, capacity, is_group, active, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `);
    ltInsert.run(tenantId, "30 Min Lesson", 30, 1, 0, 1, now);
    ltInsert.run(tenantId, "1 Hour Lesson", 60, 1, 0, 2, now);
    ltInsert.run(tenantId, "Group Clinic", 60, 4, 1, 3, now);

    // 4. Seed weekday availability (Mon-Fri 6-8 PM) so brand-new tenants
    //    aren't staring at an empty calendar.  Mode 'both' = solo & group allowed.
    //    Sundays/Saturdays remain closed by default.
    const availInsert = sqlite.prepare(`
      INSERT INTO availability (tenant_id, day_of_week, start_time, end_time, mode)
      VALUES (?, ?, '18:00', '20:00', 'both')
    `);
    for (const dow of [1, 2, 3, 4, 5]) availInsert.run(tenantId, dow);

    // 5. Owner session token so we can sign them in on the new subdomain.
    const token = randomBytes(32).toString("hex");
    const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    sqlite.prepare(`
      INSERT INTO admin_sessions (token, created_at, expires_at, tenant_id)
      VALUES (?, ?, ?, ?)
    `).run(token, now, now + SESSION_TTL_MS, tenantId);

    return { tenantId, token };
  });

  try {
    const { tenantId, token } = tx();
    return { ok: true, tenantId, slug, sessionToken: token, trialEndsAt };
  } catch (err: any) {
    // Most likely cause: a race where two signups grabbed the same slug between
    // checkSlug and the insert.  Surface a friendly error.
    const msg = String(err?.message || err || "");
    if (msg.includes("UNIQUE") && msg.includes("slug")) {
      return { ok: false, error: "That subdomain was just taken — pick another", field: "slug" };
    }
    console.error("[signup] failed:", err);
    return { ok: false, error: "Could not create the account. Please try again." };
  }
}
