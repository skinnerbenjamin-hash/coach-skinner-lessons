import express from 'express';
import type { Express, Request } from 'express';
import fs from "node:fs";
import path from "node:path";

// HTML-escape user-controlled tenant strings before injecting into the document
// head. Tenants control their own name/tagline so we treat them as untrusted.
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Defaults used when no tenant resolves (e.g. unknown subdomain) so the page
// still has a sensible title/description.
const DEFAULTS = {
  title: "LessonSpot — Book a session",
  description: "Book lessons with your coach. Pick multiple times, manage your bookings, and get reminders.",
  themeColor: "#0d9488",
  favicon: "/favicon.png",
};

// Replace template tokens in the built index.html with tenant-aware values.
// Tokens are intentionally simple {{NAME}} placeholders so we don't need a
// templating engine.
// Marketing copy used when the request is for the apex host.  The marketing
// landing component reads window.__APEX__ to know it should render itself.
const APEX_META = {
  title: "LessonSpot — The booking site for coaches and teachers",
  description: "Spin up your own branded booking site in under a minute. 14-day free trial, no card required.",
  themeColor: "#0d9488",
};

function renderIndex(template: string, req: Request): string {
  const apex = !!req.isApex;
  const t = req.tenant ?? null;

  let title: string;
  let description: string;
  let themeColor: string;
  let favicon: string;

  if (apex) {
    title = APEX_META.title;
    description = APEX_META.description;
    themeColor = APEX_META.themeColor;
    favicon = DEFAULTS.favicon;
  } else if (t) {
    title = `${t.name} — Book a session`;
    description = (t.tagline && t.tagline.trim().length > 0)
      ? t.tagline
      : `Book lessons with ${t.name}. Pick multiple times, manage your bookings, and get reminders.`;
    themeColor = t.primary_color || DEFAULTS.themeColor;
    favicon = (t.logo_path && t.logo_path.trim().length > 0) ? t.logo_path : DEFAULTS.favicon;
  } else {
    title = DEFAULTS.title;
    description = DEFAULTS.description;
    themeColor = DEFAULTS.themeColor;
    favicon = DEFAULTS.favicon;
  }

  // Inject an apex flag the SPA can read at boot.  We splice a tiny inline
  // script just before </head> so the bundle script (which runs after head
  // close) can read window.__APEX__ immediately.
  const apexScript = `<script>window.__APEX__=${apex ? "true" : "false"};</script>`;
  const withApex = template.replace(/<\/head>/i, `${apexScript}</head>`);

  return withApex
    .replace(/\{\{TENANT_TITLE\}\}/g, esc(title))
    .replace(/\{\{TENANT_DESCRIPTION\}\}/g, esc(description))
    .replace(/\{\{TENANT_THEME_COLOR\}\}/g, esc(themeColor))
    .replace(/\{\{TENANT_FAVICON\}\}/g, esc(favicon));
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Read the index.html template once at boot.  Re-read on every request only
  // if the file has changed (dev). In production the file is static so we
  // cache aggressively.
  const indexPath = path.resolve(distPath, "index.html");
  let cachedTemplate = fs.readFileSync(indexPath, "utf-8");

  // Static assets: served before the SPA fallback, with index disabled so the
  // catch-all below always runs for paths that don't have a file extension.
  // We exclude index.html from express.static so our tenant injector is the
  // only handler that serves it.
  app.use(express.static(distPath, { index: false }));

  // SPA fallback: every non-asset path renders index.html with tenant tokens
  // substituted from req.tenant (populated upstream by createTenantMiddleware).
  app.use("/{*path}", (req, res) => {
    const html = renderIndex(cachedTemplate, req);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Per-tenant content means we can't share this response across tenants.
    // Vary on Host so any upstream CDN caches separately by subdomain.
    res.setHeader("Vary", "Host");
    res.send(html);
  });
}
