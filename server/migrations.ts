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
  `);

  // ---- 2. Seed default tenant ------------------------------------------
  const tenantCount = (sqlite.prepare(`SELECT COUNT(*) AS n FROM tenants`).get() as { n: number }).n;
  if (tenantCount === 0) {
    sqlite
      .prepare(
        `INSERT INTO tenants (id, slug, name, custom_domain, timezone, active, created_at)
         VALUES (1, 'skinner', 'Coach Skinner', 'book.skinnersoftball.com',
                 'America/Indiana/Indianapolis', 1, ?)`
      )
      .run(Date.now());
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
}
