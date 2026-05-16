import {
  availability, bookings, dateOverrides, profiles, normalizePhone,
} from '@shared/schema';
import type {
  Availability, InsertAvailability,
  Booking, InsertBooking,
  DateOverride, InsertDateOverride,
  Profile, InsertProfile, BookingWithProfile,
} from '@shared/schema';
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, and, gte, lte, inArray } from "drizzle-orm";

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
`);

// Migration: add email column to existing profiles tables that pre-date the email feature.
try {
  const cols = sqlite.prepare(`PRAGMA table_info(profiles)`).all() as { name: string }[];
  if (!cols.some(c => c.name === "email")) {
    sqlite.exec(`ALTER TABLE profiles ADD COLUMN email TEXT NOT NULL DEFAULT ''`);
  }
} catch (e) { console.error("profiles email migration failed:", e); }

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
  getProfileById(id: number): Profile | undefined {
    return db.select().from(profiles).where(eq(profiles.id, id)).get();
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
    };
  }
}

export const storage = new DatabaseStorage();
