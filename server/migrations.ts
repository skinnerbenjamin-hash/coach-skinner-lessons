// Idempotent schema migrations for multi-tenant rollout (LessonSpot phase 1).
//
// This runs on every server boot. Each step checks the current schema state
// before mutating, so it's safe to run repeatedly.
//
// Strategy:
//   1. Create new tables (tenants, lesson_types, booking_participants)
//   2. Seed tenant id=1 (Coach Skinner) if no tenants exist
//   3. Add tenant_id column to every legacy table, defaulting existing rows to 1
//   4. Add lesson_type_id column to bookings, leave null (resolved at read time)
//   5. Seed default lesson types for tenant 1 if none exist
//   6. Backfill booking_participants from existing bookings
//   7. Replace the legacy phone UNIQUE constraint on profiles with a
//      composite (tenant_id, phone) unique index
//
// We do NOT drop or rename existing columns. The legacy app keeps working
// because every existing row gets tenant_id=1 and code paths default to
// tenant 1 until the tenant resolution middleware is wired up.

import type Database from "better-sqlite3";

type DB = Database.Database;

function tableExists(sqlite: DB, name: string): boolean {
  const row = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
  return !!row;
}

function columnExists(sqlite: DB, table: string, column: string): boolean {
  if (!tableExists(sqlite, table)) return false;
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function indexExists(sqlite: DB, name: string): boolean {
  const row = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(name);
  return !!row;
}

/**
 * Add a NOT NULL column with a default. SQLite allows this in a single
 * ALTER TABLE for literal defaults.
 */
function addTenantIdColumn(sqlite: DB, table: string) {
  if (!tableExists(sqlite, table)) return;
  if (columnExists(sqlite, table, "tenant_id")) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`);
}

export function runMigrations(sqlite: DB) {
  // ---- 1. Create new core tables ---------------------------------------
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      custom_domain TEXT,
      timezone TEXT NOT NULL DEFAULT 'America/Indiana/Indianapolis',
      active INTEGER NOT NULL DEFAULT 1,
      sport TEXT NOT NULL DEFAULT 'softball',
      primary_color TEXT NOT NULL DEFAULT '#0ea5e9',
      logo_path TEXT NOT NULL DEFAULT '',
      hero_path TEXT NOT NULL DEFAULT '',
      tagline TEXT NOT NULL DEFAULT '',
      about TEXT NOT NULL DEFAULT '',
      contact_phone TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      contact_location TEXT NOT NULL DEFAULT '',
      booker_label TEXT NOT NULL DEFAULT 'Parent',
      attendee_label TEXT NOT NULL DEFAULT 'Player',
      plan TEXT NOT NULL DEFAULT 'trial',
      trial_ends_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tenants_custom_domain_unique
      ON tenants(custom_domain) WHERE custom_domain IS NOT NULL;

    CREATE TABLE IF NOT EXISTS lesson_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      duration_min INTEGER NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lesson_types_tenant_idx ON lesson_types(tenant_id);

    CREATE TABLE IF NOT EXISTS booking_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      booking_group TEXT NOT NULL,
      profile_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS booking_participants_group_idx
      ON booking_participants(booking_group);
    CREATE INDEX IF NOT EXISTS booking_participants_profile_idx
      ON booking_participants(profile_id);

    CREATE TABLE IF NOT EXISTS resource_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      slug TEXT NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS resource_categories_tenant_idx
      ON resource_categories(tenant_id);
    CREATE UNIQUE INDEX IF NOT EXISTS resource_categories_tenant_slug_unique
      ON resource_categories(tenant_id, slug);
  `);

  // ---- 1a. Backfill branding columns on existing tenants tables --------
  // For DBs that were upgraded from the previous migration (tenants table
  // existed without branding columns), add the missing columns now.
  const tenantBrandingCols: { col: string; def: string }[] = [
    { col: "sport", def: "TEXT NOT NULL DEFAULT 'softball'" },
    { col: "primary_color", def: "TEXT NOT NULL DEFAULT '#0ea5e9'" },
    { col: "logo_path", def: "TEXT NOT NULL DEFAULT ''" },
    { col: "hero_path", def: "TEXT NOT NULL DEFAULT ''" },
    { col: "tagline", def: "TEXT NOT NULL DEFAULT ''" },
    { col: "about", def: "TEXT NOT NULL DEFAULT ''" },
    { col: "contact_phone", def: "TEXT NOT NULL DEFAULT ''" },
    { col: "contact_email", def: "TEXT NOT NULL DEFAULT ''" },
    { col: "contact_location", def: "TEXT NOT NULL DEFAULT ''" },
    { col: "booker_label", def: "TEXT NOT NULL DEFAULT 'Parent'" },
    { col: "attendee_label", def: "TEXT NOT NULL DEFAULT 'Player'" },
    { col: "plan", def: "TEXT NOT NULL DEFAULT 'trial'" },
    { col: "trial_ends_at", def: "INTEGER" },
  ];
  for (const { col, def } of tenantBrandingCols) {
    if (!columnExists(sqlite, "tenants", col)) {
      sqlite.exec(`ALTER TABLE tenants ADD COLUMN ${col} ${def}`);
    }
  }

  // ---- 2. Seed default tenant ------------------------------------------
  // Tenant 1 is Coach Skinner. Branding fields are pre-populated with values
  // that match the existing live site so nothing visibly changes after the
  // upgrade. The coach can customize them later from the admin Branding page.
  const tenantCount = (sqlite.prepare(`SELECT COUNT(*) AS n FROM tenants`).get() as { n: number }).n;
  if (tenantCount === 0) {
    sqlite
      .prepare(
        `INSERT INTO tenants (
           id, slug, name, custom_domain, timezone, active,
           sport, primary_color, logo_path, hero_path,
           tagline, about,
           contact_phone, contact_email, contact_location,
           booker_label, attendee_label,
           plan, trial_ends_at, created_at
         ) VALUES (
           1, 'skinner', 'Coach Skinner', 'book.skinnersoftball.com',
           'America/Indiana/Indianapolis', 1,
           'softball', '#0ea5e9', '', '',
           'Private softball lessons with Coach Skinner',
           '',
           '9079527860', 'skinnerbenjamin@yahoo.com', 'Greenwood, IN',
           'Parent', 'Player',
           'monthly', NULL, ?
         )`
      )
      .run(Date.now());
  } else {
    // Tenant already exists from a prior migration run — backfill branding
    // fields if any were left empty/default after the column-add step.
    const t = sqlite
      .prepare(`SELECT id, sport, primary_color, tagline, contact_phone, contact_email, contact_location, booker_label, attendee_label FROM tenants WHERE id = 1`)
      .get() as any;
    if (t) {
      const updates: string[] = [];
      const args: any[] = [];
      if (!t.tagline) {
        updates.push("tagline = ?");
        args.push("Private softball lessons with Coach Skinner");
      }
      if (!t.contact_phone) {
        updates.push("contact_phone = ?");
        args.push("9079527860");
      }
      if (!t.contact_email) {
        updates.push("contact_email = ?");
        args.push("skinnerbenjamin@yahoo.com");
      }
      if (!t.contact_location) {
        updates.push("contact_location = ?");
        args.push("Greenwood, IN");
      }
      if (updates.length) {
        args.push(1);
        sqlite.prepare(`UPDATE tenants SET ${updates.join(", ")} WHERE id = ?`).run(...args);
      }
    }
  }

  // ---- 3. Add tenant_id to every legacy table --------------------------
  // Every existing row defaults to tenant_id=1, which is Coach Skinner.
  // This keeps the production site behaving identically.
  const legacyTables = [
    "availability",
    "profiles",
    "bookings",
    "date_overrides",
    "coaching_notes",
    "resources",
    "admin_credentials",
    "admin_users",
    "admin_sessions",
    "reminders",
    "settings",
  ];
  for (const t of legacyTables) addTenantIdColumn(sqlite, t);

  // ---- 4. Add lesson_type_id to bookings -------------------------------
  if (tableExists(sqlite, "bookings") && !columnExists(sqlite, "bookings", "lesson_type_id")) {
    sqlite.exec(`ALTER TABLE bookings ADD COLUMN lesson_type_id INTEGER`);
  }

  // ---- 5. Seed default lesson types for tenant 1 -----------------------
  const ltCount = (
    sqlite
      .prepare(`SELECT COUNT(*) AS n FROM lesson_types WHERE tenant_id = 1`)
      .get() as { n: number }
  ).n;
  if (ltCount === 0) {
    const now = Date.now();
    const insert = sqlite.prepare(
      `INSERT INTO lesson_types (tenant_id, name, duration_min, capacity, active, sort_order, created_at)
       VALUES (1, ?, ?, ?, 1, ?, ?)`
    );
    insert.run("30 Min Lesson", 30, 1, 0, now);
    insert.run("1 Hour Lesson", 60, 1, 1, now);
  }

  // ---- 5a. Seed default resource categories for tenant 1 ---------------
  // Use the softball preset; matches the legacy hardcoded list exactly.
  const rcCount = (
    sqlite
      .prepare(`SELECT COUNT(*) AS n FROM resource_categories WHERE tenant_id = 1`)
      .get() as { n: number }
  ).n;
  if (rcCount === 0) {
    const presets = [
      { slug: "hitting", label: "Hitting" },
      { slug: "pitching", label: "Pitching" },
      { slug: "fielding", label: "Fielding" },
      { slug: "catching", label: "Catching" },
      { slug: "baserunning", label: "Baserunning" },
      { slug: "strength", label: "Strength & conditioning" },
      { slug: "mental", label: "Mental game" },
      { slug: "general", label: "General" },
    ];
    const now = Date.now();
    const insertRc = sqlite.prepare(
      `INSERT INTO resource_categories (tenant_id, slug, label, sort_order, created_at)
       VALUES (1, ?, ?, ?, ?)`
    );
    presets.forEach((p, i) => insertRc.run(p.slug, p.label, i, now));
  }

  // ---- 6. Backfill booking_participants from existing bookings ---------
  // For every existing booking that doesn't already have a participant row
  // for the same booking_group + profile_id pair, insert one.
  if (tableExists(sqlite, "bookings")) {
    const orphans = sqlite
      .prepare(
        `SELECT b.booking_group, b.profile_id, b.tenant_id, MIN(b.created_at) AS created_at
         FROM bookings b
         LEFT JOIN booking_participants bp
           ON bp.booking_group = b.booking_group AND bp.profile_id = b.profile_id
         WHERE bp.id IS NULL
         GROUP BY b.booking_group, b.profile_id`
      )
      .all() as { booking_group: string; profile_id: number; tenant_id: number; created_at: number }[];

    const insertBp = sqlite.prepare(
      `INSERT INTO booking_participants (tenant_id, booking_group, profile_id, created_at)
       VALUES (?, ?, ?, ?)`
    );
    for (const o of orphans) {
      insertBp.run(o.tenant_id || 1, o.booking_group, o.profile_id, o.created_at);
    }
  }

  // ---- 7. Replace profiles.phone unique constraint ---------------------
  // The legacy table has UNIQUE(phone). We want UNIQUE(tenant_id, phone)
  // so two different coaches can each have the same family.
  //
  // SQLite can't drop a column-level UNIQUE constraint without rebuilding
  // the table, so we do that surgery here. Only runs once: detected by
  // checking for the new composite index.
  if (
    tableExists(sqlite, "profiles") &&
    !indexExists(sqlite, "profiles_tenant_phone_unique")
  ) {
    // Check if the legacy single-column unique exists (via auto-index)
    const profileIndexes = sqlite
      .prepare(`PRAGMA index_list(profiles)`)
      .all() as { name: string; unique: number; origin?: string }[];
    const hasLegacyUnique = profileIndexes.some(
      (idx) => idx.unique === 1 && idx.name.startsWith("sqlite_autoindex_profiles")
    );

    if (hasLegacyUnique) {
      // Rebuild the table without the column-level UNIQUE on phone.
      const txn = sqlite.transaction(() => {
        // Gather columns from the current table so we can copy them across,
        // including any future-added columns we don't know about.
        const cols = sqlite.prepare(`PRAGMA table_info(profiles)`).all() as {
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }[];

        // Build column definitions, removing the UNIQUE only (everything else preserved).
        const defs = cols
          .map((c) => {
            let def = `${c.name} ${c.type}`;
            if (c.pk === 1) def += ` PRIMARY KEY AUTOINCREMENT`;
            if (c.notnull && c.pk !== 1) def += ` NOT NULL`;
            if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`;
            return def;
          })
          .join(", ");

        const colNames = cols.map((c) => c.name).join(", ");

        sqlite.exec(`CREATE TABLE profiles_new (${defs})`);
        sqlite.exec(`INSERT INTO profiles_new (${colNames}) SELECT ${colNames} FROM profiles`);
        sqlite.exec(`DROP TABLE profiles`);
        sqlite.exec(`ALTER TABLE profiles_new RENAME TO profiles`);
      });
      txn();
    }

    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS profiles_tenant_phone_unique
       ON profiles(tenant_id, phone)`
    );
  }

  // ---- 7b. Replace admin_users.phone unique constraint ----------------
  // The legacy table has UNIQUE(phone), which prevents two different tenants
  // from each having an admin who happens to share the same phone number
  // (rare in practice, but real). Rebuild to UNIQUE(tenant_id, phone).
  // Idempotent: detected by the presence of the new composite index.
  if (
    tableExists(sqlite, "admin_users") &&
    !indexExists(sqlite, "admin_users_tenant_phone_unique")
  ) {
    const adminUserIndexes = sqlite
      .prepare(`PRAGMA index_list(admin_users)`)
      .all() as { name: string; unique: number; origin?: string }[];
    const hasLegacyUnique = adminUserIndexes.some(
      (idx) => idx.unique === 1 && idx.name.startsWith("sqlite_autoindex_admin_users")
    );

    if (hasLegacyUnique) {
      const txn = sqlite.transaction(() => {
        const cols = sqlite.prepare(`PRAGMA table_info(admin_users)`).all() as {
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }[];
        const defs = cols
          .map((c) => {
            let def = `${c.name} ${c.type}`;
            if (c.pk === 1) def += ` PRIMARY KEY AUTOINCREMENT`;
            if (c.notnull && c.pk !== 1) def += ` NOT NULL`;
            if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`;
            return def;
          })
          .join(", ");
        const colNames = cols.map((c) => c.name).join(", ");
        sqlite.exec(`CREATE TABLE admin_users_new (${defs})`);
        sqlite.exec(`INSERT INTO admin_users_new (${colNames}) SELECT ${colNames} FROM admin_users`);
        sqlite.exec(`DROP TABLE admin_users`);
        sqlite.exec(`ALTER TABLE admin_users_new RENAME TO admin_users`);
      });
      txn();
    }

    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS admin_users_tenant_phone_unique
       ON admin_users(tenant_id, phone)`
    );
  }

  // ---- 8. Drop legacy UNIQUE(start) on bookings -----------------------
  // Two reasons:
  //   - Different tenants can have bookings at the same wall-clock start.
  //   - Group lessons (capacity > 1) need multiple bookings at the same start.
  // Capacity is now enforced in application code at booking time.
  // (A non-unique index on (tenant_id, start) keeps lookups fast.)
  if (tableExists(sqlite, "bookings")) {
    sqlite.exec(`DROP INDEX IF EXISTS bookings_start_unique`);
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS bookings_tenant_start_idx
       ON bookings(tenant_id, start)`
    );
  }

  // ---- 9. Lesson-mode windows (Phase 2) -------------------------------
  // Coaches can now mark availability windows (and one-off extra-open
  // overrides) as solo-only, group-only, or both. Lesson types get a
  // matching is_group flag. Customer slot picker filters slots so that a
  // solo lesson only appears in solo/both windows, and likewise for group.
  //
  // All new columns default to legacy-safe values:
  //   - lesson_types.is_group default 0 (everything pre-Phase-2 is solo)
  //   - availability.mode default 'both' (windows are unrestricted)
  //   - date_overrides.mode default 'both'
  if (tableExists(sqlite, "lesson_types") && !columnExists(sqlite, "lesson_types", "is_group")) {
    sqlite.exec(`ALTER TABLE lesson_types ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0`);
    // Heuristic: any seeded/existing lesson type with capacity > 1 is a group lesson.
    sqlite.exec(`UPDATE lesson_types SET is_group = 1 WHERE capacity > 1`);
  }
  if (tableExists(sqlite, "availability") && !columnExists(sqlite, "availability", "mode")) {
    sqlite.exec(`ALTER TABLE availability ADD COLUMN mode TEXT NOT NULL DEFAULT 'both'`);
  }
  if (tableExists(sqlite, "date_overrides") && !columnExists(sqlite, "date_overrides", "mode")) {
    sqlite.exec(`ALTER TABLE date_overrides ADD COLUMN mode TEXT NOT NULL DEFAULT 'both'`);
  }

  // ---- 10. Waitlist (Phase 2) -----------------------------------------
  // Customers can opt into a waitlist for full group slots. When a booking
  // for that (slot, lesson type) is cancelled, every name on the waitlist
  // for that exact (start, lesson_type_id) is notified. They race to claim.
  // Per-tenant. waitlist_enabled is stored in settings keyed per tenant.
  if (!tableExists(sqlite, "waitlist")) {
    sqlite.exec(`
      CREATE TABLE waitlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        start TEXT NOT NULL,
        lesson_type_id INTEGER NOT NULL,
        parent_name TEXT NOT NULL,
        player_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        participants_count INTEGER NOT NULL DEFAULT 1,
        notified_at INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS waitlist_tenant_slot_idx
       ON waitlist(tenant_id, start, lesson_type_id)`
    );
  }
}
