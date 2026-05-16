import {
  availability, bookings, dateOverrides, profiles, coachingNotes, resources, normalizePhone,
} from '@shared/schema';
import type {
  Availability, InsertAvailability,
  Booking, InsertBooking,
  DateOverride, InsertDateOverride,
  Profile, InsertProfile, BookingWithProfile,
  CoachingNote, InsertCoachingNote,
  Resource, InsertResource,
} from '@shared/schema';
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, and, gte, lte, inArray, desc } from "drizzle-orm";

const sqlite = new Database(process.env.DB_PATH || "data.db");
sqlite.pragma("journal_mode = WAL");

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

export const db = drizzle(sqlite);

// Seed default availability the first time: Mon–Sat 8am–6pm
const existing = db.select().from(availability).all();
if (existing.length === 0) {
  for (let d = 1; d <= 6; d++) {
    db.insert(availability).values({ dayOfWeek: d, startTime: "08:00", endTime: "18:00" }).run();
  }
}

export class DatabaseStorage {
  // availability
  getAvailability() { return db.select().from(availability).all(); }
  setAvailability(rows: InsertAvailability[]) {
    db.delete(availability).run();
    if (rows.length) db.insert(availability).values(rows).run();
  }
  // overrides
  getDateOverrides() { return db.select().from(dateOverrides).all(); }
  addDateOverride(o: InsertDateOverride) { return db.insert(dateOverrides).values(o).returning().get(); }
  deleteDateOverride(id: number) { db.delete(dateOverrides).where(eq(dateOverrides.id, id)).run(); }

  // profiles
  getProfileByPhone(phone: string): Profile | undefined {
    const p = normalizePhone(phone);
    return db.select().from(profiles).where(eq(profiles.phone, p)).get();
  }
  getProfileByEmail(email: string): Profile | undefined {
    const e = email.trim().toLowerCase();
    if (!e) return undefined;
    // case-insensitive lookup
    const all = db.select().from(profiles).all();
    return all.find(p => (p.email || "").trim().toLowerCase() === e);
  }
  getProfileById(id: number): Profile | undefined {
    return db.select().from(profiles).where(eq(profiles.id, id)).get();
  }
  getAllProfiles(): Profile[] {
    return db.select().from(profiles).orderBy(desc(profiles.createdAt)).all();
  }
  deleteProfile(id: number) {
    db.delete(profiles).where(eq(profiles.id, id)).run();
  }
  updateProfile(id: number, patch: { email?: string; parentName?: string; playerName?: string; phone?: string; notes?: string; photoPath?: string }): Profile | undefined {
    const existing = this.getProfileById(id);
    if (!existing) return undefined;
    const fields: Record<string, string> = {};
    if (patch.email !== undefined) fields.email = patch.email;
    if (patch.parentName !== undefined) fields.parentName = patch.parentName;
    if (patch.playerName !== undefined) fields.playerName = patch.playerName;
    if (patch.phone !== undefined) fields.phone = normalizePhone(patch.phone);
    if (patch.notes !== undefined) fields.notes = patch.notes;
    if (patch.photoPath !== undefined) fields.photoPath = patch.photoPath;
    if (Object.keys(fields).length === 0) return existing;
    db.update(profiles).set(fields).where(eq(profiles.id, id)).run();
    return this.getProfileById(id);
  }

  // Coaching notes
  getNotesForProfile(profileId: number): CoachingNote[] {
    return db.select().from(coachingNotes).where(eq(coachingNotes.profileId, profileId))
      .orderBy(coachingNotes.createdAt).all();
  }
  addNote(input: InsertCoachingNote): CoachingNote {
    return db.insert(coachingNotes).values({ ...input, createdAt: Date.now() }).returning().get();
  }
  getNoteById(id: number): CoachingNote | undefined {
    return db.select().from(coachingNotes).where(eq(coachingNotes.id, id)).get();
  }
  deleteNote(id: number) {
    db.delete(coachingNotes).where(eq(coachingNotes.id, id)).run();
  }
  upsertProfile(input: InsertProfile): Profile {
    const phone = normalizePhone(input.phone);
    const existing = this.getProfileByPhone(phone);
    if (existing) {
      db.update(profiles).set({
        email: input.email ?? existing.email ?? "",
        parentName: input.parentName,
        playerName: input.playerName,
        notes: input.notes ?? existing.notes ?? "",
      }).where(eq(profiles.id, existing.id)).run();
      return this.getProfileById(existing.id)!;
    }
    return db.insert(profiles).values({
      phone,
      email: input.email ?? "",
      parentName: input.parentName,
      playerName: input.playerName,
      notes: input.notes ?? "",
      createdAt: Date.now(),
    }).returning().get();
  }

  // bookings
  getBookings(): Booking[] { return db.select().from(bookings).all(); }
  getBookingsInRange(startDate: string, endDate: string): Booking[] {
    return db.select().from(bookings)
      .where(and(gte(bookings.start, startDate), lte(bookings.start, endDate))).all();
  }
  getBookingsByStarts(starts: string[]): Booking[] {
    if (!starts.length) return [];
    return db.select().from(bookings).where(inArray(bookings.start, starts)).all();
  }
  getBookingById(id: number): Booking | undefined {
    return db.select().from(bookings).where(eq(bookings.id, id)).get();
  }
  getBookingsForProfile(profileId: number): Booking[] {
    return db.select().from(bookings).where(eq(bookings.profileId, profileId)).all();
  }
  createBookings(rows: InsertBooking[]): Booking[] {
    const out: Booking[] = [];
    for (const r of rows) out.push(db.insert(bookings).values(r).returning().get());
    return out;
  }
  updateBookingStart(id: number, newStart: string) {
    db.update(bookings).set({ start: newStart }).where(eq(bookings.id, id)).run();
  }
  deleteBooking(id: number) { db.delete(bookings).where(eq(bookings.id, id)).run(); }
  deleteBookingGroup(groupId: string) {
    db.delete(bookings).where(eq(bookings.bookingGroup, groupId)).run();
  }

  // resources
  getResources(): Resource[] {
    return db.select().from(resources).orderBy(desc(resources.createdAt)).all();
  }
  getResourceById(id: number): Resource | undefined {
    return db.select().from(resources).where(eq(resources.id, id)).get();
  }
  createResource(input: InsertResource): Resource {
    return db.insert(resources).values({ ...input, createdAt: Date.now() }).returning().get();
  }
  deleteResource(id: number) {
    db.delete(resources).where(eq(resources.id, id)).run();
  }
  updateResource(id: number, patch: Partial<InsertResource>): Resource | undefined {
    const existing = this.getResourceById(id);
    if (!existing) return undefined;
    db.update(resources).set(patch).where(eq(resources.id, id)).run();
    return this.getResourceById(id);
  }

  // expand booking with profile data
  expandBooking(b: Booking): BookingWithProfile {
    const p = this.getProfileById(b.profileId);
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
