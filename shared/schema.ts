import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// =========================================================================
// MULTI-TENANT CORE
// =========================================================================
// A tenant is one coach/business on LessonSpot. Identified by:
//   - slug: subdomain on lessonspot.app (e.g. "skinner" -> skinner.lessonspot.app)
//   - customDomain (optional): vanity domain (e.g. book.skinnersoftball.com)
// Every row in every other table belongs to exactly one tenant via tenantId.
export const tenants = sqliteTable("tenants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  customDomain: text("custom_domain"), // nullable; unique when set
  timezone: text("timezone").notNull().default("America/Indiana/Indianapolis"),
  active: integer("active").notNull().default(1), // 1 = enabled, 0 = disabled
  createdAt: integer("created_at").notNull(),
});
export const insertTenantSchema = createInsertSchema(tenants).omit({ id: true, createdAt: true });
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenants.$inferSelect;

// Lesson type catalog (per tenant). Examples:
//   "1 Hour Lesson" / 60 min / capacity 1
//   "30 Min Lesson" / 30 min / capacity 1
//   "Group Clinic"  / 60 min / capacity 6
// durationMin must be a multiple of 30 (matches the underlying slot grid).
export const lessonTypes = sqliteTable("lesson_types", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  name: text("name").notNull(),
  durationMin: integer("duration_min").notNull(),
  capacity: integer("capacity").notNull().default(1),
  active: integer("active").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});
export const insertLessonTypeSchema = createInsertSchema(lessonTypes).omit({ id: true, createdAt: true });
export type InsertLessonType = z.infer<typeof insertLessonTypeSchema>;
export type LessonType = typeof lessonTypes.$inferSelect;

// =========================================================================
// EXISTING TABLES (now tenant-scoped via tenantId)
// =========================================================================

// Coach's weekly recurring availability.
// dayOfWeek: 0=Sun..6=Sat. Times "HH:MM" local (America/Indiana/Indianapolis).
export const availability = sqliteTable("availability", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  dayOfWeek: integer("day_of_week").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
});
export const insertAvailabilitySchema = createInsertSchema(availability).omit({ id: true });
export type InsertAvailability = z.infer<typeof insertAvailabilitySchema>;
export type Availability = typeof availability.$inferSelect;

// Customer profile, keyed by phone number (digits-only) PER TENANT.
// The legacy unique(phone) constraint is replaced by a composite unique
// (tenant_id, phone) — see migration runner. Two different coaches can have
// the same family in their own books.
export const profiles = sqliteTable("profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  phone: text("phone").notNull(),
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
// profileId is the primary booker (legacy field — kept for backward compat
// and convenience). For group lessons, additional attendees are stored in
// booking_participants. lessonTypeId is nullable on legacy rows; the migration
// runner backfills it to the tenant's default 30-min type.
export const bookings = sqliteTable("bookings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  start: text("start").notNull(),
  profileId: integer("profile_id").notNull(),
  lessonTypeId: integer("lesson_type_id"),
  bookingGroup: text("booking_group").notNull(),
  createdAt: integer("created_at").notNull(),
});
export const insertBookingSchema = createInsertSchema(bookings).omit({ id: true });
export type InsertBooking = z.infer<typeof insertBookingSchema>;
export type Booking = typeof bookings.$inferSelect;

// Date-specific overrides. type: "closed" | "extra".
export const dateOverrides = sqliteTable("date_overrides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  date: text("date").notNull(),
  type: text("type").notNull(),
  startTime: text("start_time"),
  endTime: text("end_time"),
});
export const insertDateOverrideSchema = createInsertSchema(dateOverrides).omit({ id: true });
export type InsertDateOverride = z.infer<typeof insertDateOverrideSchema>;
export type DateOverride = typeof dateOverrides.$inferSelect;

// Group lesson participants. For 1-on-1 bookings (capacity 1), there's just
// one row here pointing at the primary profile. For group lessons (capacity > 1)
// there are up to `capacity` rows for the same bookingGroup.
export const bookingParticipants = sqliteTable("booking_participants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  bookingGroup: text("booking_group").notNull(),
  profileId: integer("profile_id").notNull(),
  createdAt: integer("created_at").notNull(),
});
export const insertBookingParticipantSchema = createInsertSchema(bookingParticipants).omit({ id: true, createdAt: true });
export type InsertBookingParticipant = z.infer<typeof insertBookingParticipantSchema>;
export type BookingParticipant = typeof bookingParticipants.$inferSelect;

// Coaching notes thread between coach and parent. One row per message.
export const coachingNotes = sqliteTable("coaching_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
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
  tenantId: integer("tenant_id").notNull(),
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
