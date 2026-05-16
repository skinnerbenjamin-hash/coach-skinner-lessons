import {
  availability, bookings, dateOverrides, profiles, coachingNotes, resources, lessonTypes, normalizePhone,
} from '@shared/schema';
import type {
  Availability, InsertAvailability,
  Booking, InsertBooking,
  DateOverride, InsertDateOverride,
  Profile, InsertProfile, BookingWithProfile,
  CoachingNote, InsertCoachingNote,
  Resource, InsertResource,
  LessonType, InsertLessonType,
} from '@shared/schema';
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, and, gte, lte, inArray, desc } from "drizzle-orm";
import { runMigrations } from "./migrations";

// Side-effect imports: force auth.ts, settings.ts, reminders.ts to run their
// CREATE TABLE IF NOT EXISTS statements before runMigrations() tries to add
// tenant_id columns to their tables. ESM import hoisting + module init order
// guarantee these run before this module's body executes.
import "./auth";
import "./settings";
import "./reminders";

const sqlite = new Database(process.env.DB_PATH || "data.db");
sqlite.pragma("journal_mode = WAL");
export { sqlite };

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day_of_week INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL DEFAULT '',
    parent_name TEXT NOT NULL,
    player_name TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start TEXT NOT NULL,
    profile_id INTEGER NOT NULL,
    booking_group TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS bookings_start_unique ON bookings(start);
  CREATE TABLE IF NOT EXISTS date_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT
  );
  CREATE TABLE IF NOT EXISTS coaching_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    media_type TEXT,
    media_path TEXT,
    media_url TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS coaching_notes_profile_idx ON coaching_notes(profile_id);
  CREATE TABLE IF NOT EXISTS resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS resources_category_idx ON resources(category);
`);

// Migration: add email column to existing profiles tables that pre-date the email feature.
try {
  const cols = sqlite.prepare(`PRAGMA table_info(profiles)`).all() as { name: string }[];
  if (!cols.some(c => c.name === "email")) {
    sqlite.exec(`ALTER TABLE profiles ADD COLUMN email TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.some(c => c.name === "photo_path")) {
    sqlite.exec(`ALTER TABLE profiles ADD COLUMN photo_path TEXT NOT NULL DEFAULT ''`);
  }
} catch (e) { console.error("profiles migration failed:", e); }

// Migration: add media columns to existing coaching_notes table that pre-date attachments.
try {
  const cols = sqlite.prepare(`PRAGMA table_info(coaching_notes)`).all() as { name: string }[];
  if (!cols.some(c => c.name === "media_type")) {
    sqlite.exec(`ALTER TABLE coaching_notes ADD COLUMN media_type TEXT`);
  }
  if (!cols.some(c => c.name === "media_path")) {
    sqlite.exec(`ALTER TABLE coaching_notes ADD COLUMN media_path TEXT`);
  }
  if (!cols.some(c => c.name === "media_url")) {
    sqlite.exec(`ALTER TABLE coaching_notes ADD COLUMN media_url TEXT`);
  }
} catch (e) { console.error("coaching_notes migration failed:", e); }

// LessonSpot multi-tenant migrations.
// At this point auth/settings/reminders have already created their tables
// (see side-effect imports at the top of this file). We can safely ALTER them.
try {
  runMigrations(sqlite);
} catch (e) {
  console.error("multi-tenant migrations failed:", e);
  throw e;
}

export const db = drizzle(sqlite);

// Seed default availability the first time: Mon–Sat 8am–6pm (tenant 1).
const existing = db.select().from(availability).all();
if (existing.length === 0) {
  for (let d = 1; d <= 6; d++) {
    db.insert(availability)
      .values({ tenantId: 1, dayOfWeek: d, startTime: "08:00", endTime: "18:00" })
      .run();
  }
}

// ---------------------------------------------------------------------------
// DatabaseStorage
//
// Every read/write below is scoped to a tenantId.  This is the security
// boundary for multi-tenancy: a missing tenantId would silently return
// cross-tenant data, so we make it a required parameter on every method.
// Routes resolve tenantId from req.tenantId (set by tenant middleware) and
// pass it in explicitly.
// ---------------------------------------------------------------------------
export class DatabaseStorage {
  // availability
  getAvailability(tenantId: number) {
    return db.select().from(availability).where(eq(availability.tenantId, tenantId)).all();
  }
  setAvailability(tenantId: number, rows: InsertAvailability[]) {
    db.delete(availability).where(eq(availability.tenantId, tenantId)).run();
    if (rows.length) {
      db.insert(availability).values(rows.map(r => ({ ...r, tenantId }))).run();
    }
  }

  // overrides
  getDateOverrides(tenantId: number) {
    return db.select().from(dateOverrides).where(eq(dateOverrides.tenantId, tenantId)).all();
  }
  addDateOverride(tenantId: number, o: InsertDateOverride): DateOverride {
    return db.insert(dateOverrides).values({ ...o, tenantId }).returning().get();
  }
  deleteDateOverride(tenantId: number, id: number) {
    db.delete(dateOverrides)
      .where(and(eq(dateOverrides.tenantId, tenantId), eq(dateOverrides.id, id)))
      .run();
  }

  // profiles
  getProfileByPhone(tenantId: number, phone: string): Profile | undefined {
    const p = normalizePhone(phone);
    return db.select().from(profiles)
      .where(and(eq(profiles.tenantId, tenantId), eq(profiles.phone, p)))
      .get();
  }
  getProfileByEmail(tenantId: number, email: string): Profile | undefined {
    const e = email.trim().toLowerCase();
    if (!e) return undefined;
    // case-insensitive lookup, scoped to tenant
    const all = db.select().from(profiles).where(eq(profiles.tenantId, tenantId)).all();
    return all.find(p => (p.email || "").trim().toLowerCase() === e);
  }
  getProfileById(tenantId: number, id: number): Profile | undefined {
    return db.select().from(profiles)
      .where(and(eq(profiles.tenantId, tenantId), eq(profiles.id, id)))
      .get();
  }
  getAllProfiles(tenantId: number): Profile[] {
    return db.select().from(profiles)
      .where(eq(profiles.tenantId, tenantId))
      .orderBy(desc(profiles.createdAt))
      .all();
  }
  deleteProfile(tenantId: number, id: number) {
    db.delete(profiles)
      .where(and(eq(profiles.tenantId, tenantId), eq(profiles.id, id)))
      .run();
  }
  updateProfile(
    tenantId: number,
    id: number,
    patch: { email?: string; parentName?: string; playerName?: string; phone?: string; notes?: string; photoPath?: string },
  ): Profile | undefined {
    const existing = this.getProfileById(tenantId, id);
    if (!existing) return undefined;
    const fields: Record<string, string> = {};
    if (patch.email !== undefined) fields.email = patch.email;
    if (patch.parentName !== undefined) fields.parentName = patch.parentName;
    if (patch.playerName !== undefined) fields.playerName = patch.playerName;
    if (patch.phone !== undefined) fields.phone = normalizePhone(patch.phone);
    if (patch.notes !== undefined) fields.notes = patch.notes;
    if (patch.photoPath !== undefined) fields.photoPath = patch.photoPath;
    if (Object.keys(fields).length === 0) return existing;
    db.update(profiles).set(fields)
      .where(and(eq(profiles.tenantId, tenantId), eq(profiles.id, id)))
      .run();
    return this.getProfileById(tenantId, id);
  }
  upsertProfile(tenantId: number, input: InsertProfile): Profile {
    const phone = normalizePhone(input.phone);
    const existing = this.getProfileByPhone(tenantId, phone);
    if (existing) {
      db.update(profiles).set({
        email: input.email ?? existing.email ?? "",
        parentName: input.parentName,
        playerName: input.playerName,
        notes: input.notes ?? existing.notes ?? "",
      }).where(and(eq(profiles.tenantId, tenantId), eq(profiles.id, existing.id))).run();
      return this.getProfileById(tenantId, existing.id)!;
    }
    return db.insert(profiles).values({
      tenantId,
      phone,
      email: input.email ?? "",
      parentName: input.parentName,
      playerName: input.playerName,
      notes: input.notes ?? "",
      createdAt: Date.now(),
    }).returning().get();
  }

  // Coaching notes
  // Notes are joined via profile_id, but we still filter by tenantId for
  // defense-in-depth so a malicious or buggy caller can't read across tenants
  // by passing another tenant's profile id.
  getNotesForProfile(tenantId: number, profileId: number): CoachingNote[] {
    return db.select().from(coachingNotes)
      .where(and(eq(coachingNotes.tenantId, tenantId), eq(coachingNotes.profileId, profileId)))
      .orderBy(coachingNotes.createdAt)
      .all();
  }
  addNote(tenantId: number, input: InsertCoachingNote): CoachingNote {
    return db.insert(coachingNotes)
      .values({ ...input, tenantId, createdAt: Date.now() })
      .returning()
      .get();
  }
  getNoteById(tenantId: number, id: number): CoachingNote | undefined {
    return db.select().from(coachingNotes)
      .where(and(eq(coachingNotes.tenantId, tenantId), eq(coachingNotes.id, id)))
      .get();
  }
  deleteNote(tenantId: number, id: number) {
    db.delete(coachingNotes)
      .where(and(eq(coachingNotes.tenantId, tenantId), eq(coachingNotes.id, id)))
      .run();
  }

  // bookings
  getBookings(tenantId: number): Booking[] {
    return db.select().from(bookings).where(eq(bookings.tenantId, tenantId)).all();
  }
  getBookingsInRange(tenantId: number, startDate: string, endDate: string): Booking[] {
    return db.select().from(bookings)
      .where(and(
        eq(bookings.tenantId, tenantId),
        gte(bookings.start, startDate),
        lte(bookings.start, endDate),
      ))
      .all();
  }
  getBookingsByStarts(tenantId: number, starts: string[]): Booking[] {
    if (!starts.length) return [];
    return db.select().from(bookings)
      .where(and(eq(bookings.tenantId, tenantId), inArray(bookings.start, starts)))
      .all();
  }
  getBookingById(tenantId: number, id: number): Booking | undefined {
    return db.select().from(bookings)
      .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, id)))
      .get();
  }
  getBookingsForProfile(tenantId: number, profileId: number): Booking[] {
    return db.select().from(bookings)
      .where(and(eq(bookings.tenantId, tenantId), eq(bookings.profileId, profileId)))
      .all();
  }
  createBookings(tenantId: number, rows: InsertBooking[]): Booking[] {
    const out: Booking[] = [];
    for (const r of rows) {
      out.push(db.insert(bookings).values({ ...r, tenantId }).returning().get());
    }
    return out;
  }
  updateBookingStart(tenantId: number, id: number, newStart: string) {
    db.update(bookings).set({ start: newStart })
      .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, id)))
      .run();
  }
  deleteBooking(tenantId: number, id: number) {
    db.delete(bookings)
      .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, id)))
      .run();
  }
  deleteBookingGroup(tenantId: number, groupId: string) {
    db.delete(bookings)
      .where(and(eq(bookings.tenantId, tenantId), eq(bookings.bookingGroup, groupId)))
      .run();
  }

  // resources
  getResources(tenantId: number): Resource[] {
    return db.select().from(resources)
      .where(eq(resources.tenantId, tenantId))
      .orderBy(desc(resources.createdAt))
      .all();
  }
  getResourceById(tenantId: number, id: number): Resource | undefined {
    return db.select().from(resources)
      .where(and(eq(resources.tenantId, tenantId), eq(resources.id, id)))
      .get();
  }
  createResource(tenantId: number, input: InsertResource): Resource {
    return db.insert(resources)
      .values({ ...input, tenantId, createdAt: Date.now() })
      .returning()
      .get();
  }
  deleteResource(tenantId: number, id: number) {
    db.delete(resources)
      .where(and(eq(resources.tenantId, tenantId), eq(resources.id, id)))
      .run();
  }
  updateResource(tenantId: number, id: number, patch: Partial<InsertResource>): Resource | undefined {
    const existing = this.getResourceById(tenantId, id);
    if (!existing) return undefined;
    db.update(resources).set(patch)
      .where(and(eq(resources.tenantId, tenantId), eq(resources.id, id)))
      .run();
    return this.getResourceById(tenantId, id);
  }

  // ===== Lesson types (per tenant) =====
  listLessonTypes(tenantId: number, opts?: { activeOnly?: boolean }): LessonType[] {
    const rows = db.select().from(lessonTypes)
      .where(eq(lessonTypes.tenantId, tenantId))
      .all();
    const filtered = opts?.activeOnly ? rows.filter(r => r.active === 1) : rows;
    return filtered.sort((a, b) => (a.sortOrder - b.sortOrder) || a.id - b.id);
  }
  getLessonTypeById(tenantId: number, id: number): LessonType | undefined {
    return db.select().from(lessonTypes)
      .where(and(eq(lessonTypes.tenantId, tenantId), eq(lessonTypes.id, id)))
      .get();
  }
  createLessonType(tenantId: number, input: Omit<InsertLessonType, "tenantId">): LessonType {
    const row = { ...input, tenantId, createdAt: Date.now() } as InsertLessonType & { createdAt: number };
    return db.insert(lessonTypes).values(row).returning().get();
  }
  updateLessonType(tenantId: number, id: number, patch: Partial<Omit<InsertLessonType, "tenantId">>): LessonType | undefined {
    const existing = this.getLessonTypeById(tenantId, id);
    if (!existing) return undefined;
    db.update(lessonTypes).set(patch)
      .where(and(eq(lessonTypes.tenantId, tenantId), eq(lessonTypes.id, id)))
      .run();
    return this.getLessonTypeById(tenantId, id);
  }
  deleteLessonType(tenantId: number, id: number) {
    db.delete(lessonTypes)
      .where(and(eq(lessonTypes.tenantId, tenantId), eq(lessonTypes.id, id)))
      .run();
  }

  // expand booking with profile data
  expandBooking(tenantId: number, b: Booking): BookingWithProfile {
    const p = this.getProfileById(tenantId, b.profileId);
    return {
      ...b,
      parentName: p?.parentName ?? "(unknown)",
      playerName: p?.playerName ?? "(unknown)",
      phone: p?.phone ?? "",
      email: p?.email ?? "",
      notes: p?.notes ?? "",
      photoPath: p?.photoPath ?? "",
    };
  }
}

export const storage = new DatabaseStorage();
