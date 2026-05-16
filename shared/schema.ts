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
  // Optional attachment: "image" | "video" | "link" or null/empty for text-only.
  mediaType: text("media_type"),
  mediaPath: text("media_path"),   // disk path for uploads
  mediaUrl: text("media_url"),     // external URL (e.g. YouTube)
  createdAt: integer("created_at").notNull(),
});
export const insertCoachingNoteSchema = createInsertSchema(coachingNotes).omit({ id: true, createdAt: true });
export type InsertCoachingNote = z.infer<typeof insertCoachingNoteSchema>;
export type CoachingNote = typeof coachingNotes.$inferSelect;

// Resource library: handouts, links, photos shared with signed-up families.
// type: "pdf" | "link" | "image" | "video"
// category: "hitting" | "pitching" | "fielding" | "catching" | "baserunning" | "strength" | "mental" | "general"
export const resources = sqliteTable("resources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  category: text("category").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  url: text("url").notNull().default(""),       // external URL for "link", or served path for uploads
  filePath: text("file_path").notNull().default(""), // disk filename for pdf/image uploads
  createdAt: integer("created_at").notNull(),
});
export const insertResourceSchema = createInsertSchema(resources).omit({ id: true, createdAt: true });
export type InsertResource = z.infer<typeof insertResourceSchema>;
export type Resource = typeof resources.$inferSelect;

export const RESOURCE_CATEGORIES = [
  { id: "hitting", label: "Hitting" },
  { id: "pitching", label: "Pitching" },
  { id: "fielding", label: "Fielding" },
  { id: "catching", label: "Catching" },
  { id: "baserunning", label: "Baserunning" },
  { id: "strength", label: "Strength & conditioning" },
  { id: "mental", label: "Mental game" },
  { id: "general", label: "General" },
] as const;
export type ResourceCategory = typeof RESOURCE_CATEGORIES[number]["id"];

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
