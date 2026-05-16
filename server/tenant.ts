// Tenant resolution middleware
//
// Resolves the active tenant from the incoming request's Host header.
// Supports three resolution strategies, tried in order:
//   1. Exact match on tenants.custom_domain  (e.g. book.skinnersoftball.com)
//   2. Subdomain match on `<slug>.lessonspot.app`  (e.g. jane.lessonspot.app)
//   3. Local development / Render preview host -> tenant id=1 (Coach Skinner)
//
// Attaches `req.tenantId` and `req.tenant` for downstream handlers.
//
// IMPORTANT: this middleware never throws.  If no tenant resolves we attach
// a null tenant and let the route decide whether to 404, redirect, or show a
// "site not found" landing page.  This keeps health checks and global static
// assets unaffected while we roll out tenant-aware routes incrementally.

import type { Request, Response, NextFunction } from "express";
import Database from "better-sqlite3";

declare global {
  namespace Express {
    interface Request {
      tenantId?: number;
      tenant?: TenantRow | null;
    }
  }
}

export interface TenantRow {
  id: number;
  slug: string;
  name: string;
  custom_domain: string | null;
  timezone: string;
  active: number;
  sport: string;
  primary_color: string;
  logo_path: string;
  hero_path: string;
  tagline: string;
  about: string;
  contact_phone: string;
  contact_email: string;
  contact_location: string;
  booker_label: string;
  attendee_label: string;
  plan: string;
  trial_ends_at: number | null;
}

// Hosts that should always resolve to tenant id=1 (the original Skinner app)
// during the transition.  Render's *.onrender.com preview URLs land here, as
// does plain `localhost`.  Once we add a real signup flow these will continue
// to be valid (they're the "owner" tenant).
const LEGACY_HOSTS = new Set<string>([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
]);

// The apex subdomain suffix.  Anything ending in this is treated as a
// `<slug>.lessonspot.app` request and the slug is matched against tenants.slug.
const APEX_SUFFIX = ".lessonspot.app";

function normalizeHost(rawHost: string | undefined): string {
  if (!rawHost) return "";
  // Strip port; lowercase; trim trailing dot.
  return rawHost.split(":")[0].toLowerCase().replace(/\.$/, "");
}

function isLegacyHost(host: string): boolean {
  if (LEGACY_HOSTS.has(host)) return true;
  if (host.endsWith(".onrender.com")) return true;
  if (host.endsWith(".replit.dev")) return true;
  if (host.endsWith(".repl.co")) return true;
  return false;
}

export function createTenantMiddleware(sqlite: Database.Database) {
  // Prepared statements are reused on every request.  These do NOT touch the
  // network and run in <0.1ms each on SQLite.
  const byCustomDomain = sqlite.prepare<[string], TenantRow>(
    `SELECT * FROM tenants WHERE custom_domain = ? AND active = 1 LIMIT 1`,
  );
  const bySlug = sqlite.prepare<[string], TenantRow>(
    `SELECT * FROM tenants WHERE slug = ? AND active = 1 LIMIT 1`,
  );
  const byId = sqlite.prepare<[number], TenantRow>(
    `SELECT * FROM tenants WHERE id = ? LIMIT 1`,
  );

  // The "default" tenant (id=1) — Coach Skinner.  Anything that doesn't match
  // a custom domain or a subdomain falls back to this so the original site
  // keeps working unchanged.
  function defaultTenant(): TenantRow | null {
    return byId.get(1) ?? null;
  }

  return function tenantMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ) {
    const host = normalizeHost(req.headers.host as string | undefined);

    // 1. Exact custom-domain match
    if (host) {
      const cd = byCustomDomain.get(host);
      if (cd) {
        req.tenant = cd;
        req.tenantId = cd.id;
        return next();
      }
    }

    // 2. <slug>.lessonspot.app subdomain match
    if (host.endsWith(APEX_SUFFIX)) {
      const slug = host.slice(0, -APEX_SUFFIX.length);
      // Reserve `www` and `app` for the marketing site (handled separately).
      if (slug && slug !== "www" && slug !== "app") {
        const t = bySlug.get(slug);
        if (t) {
          req.tenant = t;
          req.tenantId = t.id;
          return next();
        }
        // Subdomain shape but no tenant -> mark unresolved so routes can 404.
        req.tenant = null;
        req.tenantId = undefined;
        return next();
      }
    }

    // 3. Legacy/local host fallback -> tenant id=1
    if (isLegacyHost(host) || host === "") {
      const t = defaultTenant();
      req.tenant = t;
      req.tenantId = t?.id;
      return next();
    }

    // 4. Anything else: fall through with default tenant for now.  Once we
    //    have a marketing site this branch should render that instead.
    const t = defaultTenant();
    req.tenant = t;
    req.tenantId = t?.id;
    return next();
  };
}

// Helper for route handlers that want to require a resolved tenant.  Returns
// the tenantId or sends a 404 and returns null.
/**
 * Fetch full tenant row by id.  Returns null if not found.
 * Used by routes that need branding/labels (e.g. /api/coach).
 */
export function getTenantById(sqlite: Database.Database, id: number): TenantRow | null {
  const row = sqlite.prepare<[number], TenantRow>(
    `SELECT * FROM tenants WHERE id = ? LIMIT 1`,
  ).get(id);
  return row ?? null;
}

export function requireTenantId(req: Request, res: Response): number | null {
  if (typeof req.tenantId === "number") return req.tenantId;
  res.status(404).json({ message: "Site not found" });
  return null;
}
