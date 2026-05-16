import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Coach's weekly recurring availability.
// dayOfWeek: 0=Sun..6=Sat. Times "HH:MM" local (America/Indiana/Indianapolis).
export const availability = sqliteTable("availability", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dayOfWeek: integer("day_of_week").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
});
export const insertAvailabilitySchema = createInsertSchema(availability).omit({ id: true });
export type InsertAvailability = z.infer<typeof insertAvailabilitySchema>;
export type Availability = typeof availability.$inferSelect;

// Customer profile, keyed by phone number (normalized to digits-only).
export const profiles = sqliteTable("profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  phone: text("phone").notNull().unique(),
  email: text("email").notNull().default(""),
  parentName: text("parent_name").notNull(),
  playerName: text("player_name").notNull(),
  notes: text("notes").notNull().default(""),
  photoPath: text("photo_path").notNull().default(""),
  createdAt: integer("created_at").notNull(),
});
export const insertProfileSchema = createInsertSchema(profiles).omit({ id: true, createdAt: true });
export type InsertProfile = z.infer<typeof insertProfileSchema>;
export type Profile = typeof profiles.$inferSelect;

// One row per 30-minute booked slot. start = "YYYY-MM-DDTHH:MM" local time.
export const bookings = sqliteTable("bookings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  start: text("start").notNull(),
  profileId: integer("profile_id").notNull(),
  bookingGroup: text("booking_group").notNull(),
  createdAt: integer("created_at").notNull(),
});
export const insertBookingSchema = createInsertSchema(bookings).omit({ id: true });
export type InsertBooking = z.infer<typeof insertBookingSchema>;
export type Booking = typeof bookings.$inferSelect;

// Date-specific overrides. type: "closed" | "extra".
export const dateOverrides = sqliteTable("date_overrides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  type: text("type").notNull(),
  startTime: text("start_time"),
  endTime: text("end_time"),
});
export const insertDateOverrideSchema = createInsertSchema(dateOverrides).omit({ id: true });
export type InsertDateOverride = z.infer<typeof insertDateOverrideSchema>;
export type DateOverride = typeof dateOverrides.$inferSelect;

// Coaching notes thread between coach and parent. One row per message.
export const coachingNotes = sqliteTable("coaching_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  author: text("author").notNull(), // "coach" | "parent"
  text: text("text").notNull(),
  createdAt: integer("created_at").notNull(),
});
export const insertCoachingNoteSchema = createInsertSchema(coachingNotes).omit({ id: true, createdAt: true });
export type InsertCoachingNote = z.infer<typeof insertCoachingNoteSchema>;
export type CoachingNote = typeof coachingNotes.$inferSelect;

// Helper to normalize a phone number to digits only (so "(317) 555-1234" == "3175551234").
export function normalizePhone(p: string) { return (p || "").replace(/\D+/g, ""); }

export const profileLookupSchema = z.object({ phone: z.string().min(7) });

export const checkoutSchema = z.object({
  slots: z.array(z.string()).min(1),
  phone: z.string().min(7),
  email: z.string().email(),
  parentName: z.string().min(1),
  playerName: z.string().min(1),
  notes: z.string().default(""),
});
export type CheckoutPayload = z.infer<typeof checkoutSchema>;

// Booking with profile expanded — handy shape for the client.
export type BookingWithProfile = Booking & {
  parentName: string;
  playerName: string;
  phone: string;
  email: string;
  notes: string;
  photoPath: string;
};
