import type { Express, Request, Response } from "express";
import type { Server } from 'node:http';
import { storage, sqlite } from "./storage";
import { requireTenantId, getTenantById } from "./tenant";
import {
  checkoutSchema, insertAvailabilitySchema, insertDateOverrideSchema,
  insertProfileSchema, normalizePhone, insertWaitlistSchema,
} from "@shared/schema";
import type { Booking, BookingWithProfile } from "@shared/schema";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import multer from "multer";
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import {
  scheduleRemindersForBooking, cancelRemindersForBooking,
  rescheduleRemindersForBooking, listReminders, startReminderLoop,
  sendSms,
} from "./reminders";
import { getAllSettings, getSetting, setSettings, sendBookingEmail, sendEmail } from "./settings";
import {
  seedDefaultAdmin, checkLogin, logout, requireAdmin, isAuthed,
  setSessionCookie, clearSessionCookie, getTokenFromReq, updateCredentials, getAdminPhone,
  listAdminUsers, addAdminUser, updateAdminUser, deleteAdminUser, getSessionTenantId,
  createResetToken, consumeResetToken,
} from "./auth";
import { checkSlug, createTenantAndOwner } from "./signup";
import { insertResourceSchema, RESOURCE_CATEGORIES, insertLessonTypeSchema } from "@shared/schema";

startReminderLoop();
seedDefaultAdmin("9079527860", "1qaz!QAZ");

// Returns the list of admin emails that should receive booking notifications
// for a tenant. When assignedCoachId is provided, that coach's email is always
// included (even if receives_emails=0). Falls back to tenant.contact_email,
// then legacy getSetting("coachEmail"), so single-admin sites that haven't
// migrated still get email. Always deduplicated and lowercased.
function getBookingEmailRecipients(tenantId: number, assignedCoachId?: number): string[] {
  const rows = sqlite.prepare(
    `SELECT email FROM admin_users WHERE tenant_id=? AND receives_emails=1 AND email != ''`
  ).all(tenantId) as { email: string }[];
  const set = new Set<string>();
  for (const r of rows) set.add(r.email.trim().toLowerCase());
  // Always include the assigned coach's email (even if receives_emails=0)
  if (assignedCoachId !== undefined) {
    const coach = sqlite.prepare(
      `SELECT email FROM admin_users WHERE id=? AND tenant_id=? AND email != '' LIMIT 1`
    ).get(assignedCoachId, tenantId) as { email: string } | undefined;
    if (coach?.email) set.add(coach.email.trim().toLowerCase());
  }
  if (set.size === 0) {
    const tenant = getTenantById(sqlite, tenantId);
    const fallback = (tenant?.contact_email || "").trim().toLowerCase();
    if (fallback) set.add(fallback);
  }
  if (set.size === 0) {
    const legacy = (getSetting("coachEmail") || "").trim().toLowerCase();
    if (legacy) set.add(legacy);
  }
  return Array.from(set);
}

// Helper: resolve a coachId from query/body. Returns the coachId number on
// success, or null (after sending 400) on failure. For PUBLIC endpoints,
// validates that the coach has gives_lessons=1. For admin endpoints pass
// requireGivesLessons=false to allow any admin in the tenant.
function resolveCoachId(
  req: Request, res: Response, tenantId: number,
  opts: { required: boolean; requireGivesLessons?: boolean } = { required: true, requireGivesLessons: true }
): number | null | undefined {
  const raw = req.query.coachId ?? req.body?.coachId;
  if (raw === undefined || raw === null || raw === "") {
    if (opts.required) {
      res.status(400).json({ error: "coachId is required" });
      return null;
    }
    return undefined; // not provided, caller handles default
  }
  const coachId = Number(raw);
  if (!Number.isFinite(coachId)) {
    res.status(400).json({ error: "coachId must be a number" });
    return null;
  }
  const requireGL = opts.requireGivesLessons !== false;
  const query = requireGL
    ? `SELECT id FROM admin_users WHERE id=? AND tenant_id=? AND gives_lessons=1 LIMIT 1`
    : `SELECT id FROM admin_users WHERE id=? AND tenant_id=? LIMIT 1`;
  const coach = sqlite.prepare(query).get(coachId, tenantId) as { id: number } | undefined;
  if (!coach) {
    res.status(400).json({ error: requireGL ? "Invalid coach or coach does not give lessons" : "Invalid coach" });
    return null;
  }
  return coachId;
}

// Returns the single lesson-giving coach for a tenant, or null if 0 or 2+ exist.
function getSoloCoach(tenantId: number): { id: number } | null {
  const coaches = sqlite.prepare(
    `SELECT id FROM admin_users WHERE tenant_id=? AND gives_lessons=1 AND email != '' ORDER BY id LIMIT 2`
  ).all(tenantId) as { id: number }[];
  return coaches.length === 1 ? coaches[0] : null;
}

const SLOT_MIN = 30;
const MAX_GAP_MIN = 30;          // gaps <= this between busy blocks count as "orphan"
// Default booking window when a tenant row is missing the per-tenant overrides.
// Each tenant has its own max_booking_days (how far ahead customers can book)
// and min_lead_hours (minimum notice before lesson start) — see tenants schema.
const DEFAULT_MAX_BOOKING_DAYS = 30;
const DEFAULT_MIN_LEAD_HOURS = 24;
function tenantMaxBookingDays(req: any): number {
  const v = req?.tenant?.max_booking_days;
  return typeof v === "number" && v > 0 ? v : DEFAULT_MAX_BOOKING_DAYS;
}
function tenantMinLeadHours(req: any): number {
  const v = req?.tenant?.min_lead_hours;
  return typeof v === "number" && v >= 0 ? v : DEFAULT_MIN_LEAD_HOURS;
}
function tenantMaxBookingWindowMs(req: any): number {
  return tenantMaxBookingDays(req) * 24 * 60 * 60 * 1000;
}
function tenantMinLeadMs(req: any): number {
  return tenantMinLeadHours(req) * 60 * 60 * 1000;
}

// --- Uploads (photos for Phase 1) ---
const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";
const PHOTO_DIR = path.join(UPLOAD_DIR, "photos");
try { fs.mkdirSync(PHOTO_DIR, { recursive: true }); } catch {}
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only image uploads are allowed."));
  },
});

// Resource library uploads (PDFs and images)
const RESOURCE_DIR = path.join(UPLOAD_DIR, "resources");
try { fs.mkdirSync(RESOURCE_DIR, { recursive: true }); } catch {}
const resourceUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, RESOURCE_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
      const safe = Math.random().toString(36).slice(2) + "-" + Date.now() + ext;
      cb(null, safe);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB to fit video clips
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === "application/pdf" ||
      /^image\//.test(file.mimetype) ||
      /^video\//.test(file.mimetype)
    ) cb(null, true);
    else cb(new Error("Only PDF, image, or video uploads are allowed."));
  },
});
const NOTES_DIR = path.join(UPLOAD_DIR, "notes");
try { fs.mkdirSync(NOTES_DIR, { recursive: true }); } catch {}
const noteUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, NOTES_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
      const safe = Math.random().toString(36).slice(2) + "-" + Date.now() + ext;
      cb(null, safe);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB for video clips
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype) || /^video\//.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only image or video uploads are allowed."));
  },
});
// Branding uploads (logo, hero image).  Smaller cap; images only.
const BRANDING_DIR = path.join(UPLOAD_DIR, "branding");
try { fs.mkdirSync(BRANDING_DIR, { recursive: true }); } catch {}
const brandingUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, BRANDING_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
      const safe = Math.random().toString(36).slice(2) + "-" + Date.now() + ext;
      cb(null, safe);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB cap is plenty for logos/heroes
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only image uploads are allowed."));
  },
});
function isAdminReq(req: Request): boolean { return isAuthed(req); }
function matchesProofEmail(profileEmail: string, proof: string): boolean {
  const a = (profileEmail || "").trim().toLowerCase();
  const b = (proof || "").trim().toLowerCase();
  return !!a && a === b;
}

function pad(n: number) { return String(n).padStart(2, "0"); }
function toIso(date: string, time: string) { return `${date}T${time}`; }
function timeToMin(t: string) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function minToTime(m: number) { return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
function addDays(dateStr: string, days: number) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayOfWeek(dateStr: string) { return new Date(dateStr + "T12:00:00").getDay(); }
function isoToMin(iso: string) { return timeToMin(iso.split("T")[1]); }
function isoDate(iso: string) { return iso.split("T")[0]; }
function isoToLocalDate(iso: string) { return new Date(iso + ":00"); } // browser/server local

function formatTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${pad(m)} ${period}`;
}
function formatDateLong(d: string) {
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}

// open windows (in minutes-from-midnight) for a given local date.
// Each window now carries a mode: "solo" | "group" | "both" so the booking
// page can filter slots by selected lesson type. Overlapping windows with the
// same mode are merged; windows with different modes are kept separate so a
// 6–7pm group block doesn't accidentally swallow a 7–9pm solo block.
type OpenWindow = { start: number; end: number; mode: "solo" | "group" | "both" };
function normalizeMode(m: string | null | undefined): OpenWindow["mode"] {
  if (m === "solo" || m === "group") return m;
  return "both";
}
function openWindowsForDate(tenantId: number, date: string, adminUserId?: number): OpenWindow[] {
  const overrides = storage.getDateOverrides(tenantId, adminUserId).filter(o => o.date === date);
  if (overrides.some(o => o.type === "closed")) return [];
  const dow = dayOfWeek(date);
  const base = storage.getAvailability(tenantId, adminUserId).filter(a => a.dayOfWeek === dow);
  const wins: OpenWindow[] = base.map(b => ({
    start: timeToMin(b.startTime),
    end: timeToMin(b.endTime),
    mode: normalizeMode((b as any).mode),
  }));
  for (const o of overrides) {
    if (o.type === "extra" && o.startTime && o.endTime) {
      wins.push({
        start: timeToMin(o.startTime),
        end: timeToMin(o.endTime),
        mode: normalizeMode((o as any).mode),
      });
    }
  }
  wins.sort((a, b) => a.start - b.start || (a.mode > b.mode ? 1 : -1));
  const merged: OpenWindow[] = [];
  for (const w of wins) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end && last.mode === w.mode) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

// Returns slot starts (ISO local) for a date. If isGroupFilter is provided, only
// returns slots from windows whose mode is compatible:
//   - isGroupFilter=true  -> windows with mode in {"group", "both"}
//   - isGroupFilter=false -> windows with mode in {"solo", "both"}
//   - isGroupFilter=null  -> all windows (legacy behavior, used by admin views)
//
// `durationMin` is the length of the lesson the customer is booking. We only
// surface slot starts where start + durationMin fits inside an open window —
// otherwise a 60-min lesson could be booked at 7:30 PM inside a 4-8 PM window
// and run 30 min past close. Defaults to SLOT_MIN (30 min) for legacy callers.
function slotsForDate(
  tenantId: number,
  date: string,
  isGroupFilter: boolean | null = null,
  adminUserId?: number,
  durationMin: number = SLOT_MIN,
) {
  const dur = Math.max(SLOT_MIN, durationMin);
  const out: string[] = [];
  for (const w of openWindowsForDate(tenantId, date, adminUserId)) {
    if (isGroupFilter === true && w.mode === "solo") continue;
    if (isGroupFilter === false && w.mode === "group") continue;
    for (let m = w.start; m + dur <= w.end; m += SLOT_MIN) out.push(toIso(date, minToTime(m)));
  }
  return out;
}

// Counts the participants on a booking row: 1 primary + every extra in
// booking_participants minus the primary's own profile entry. Falls back
// gracefully if the table doesn't exist on older DBs.
function countParticipantsOnBooking(tenantId: number, b: { profileId: number; bookingGroup: string }): number {
  try {
    const row = sqlite
      .prepare(
        `SELECT COUNT(*) AS n
           FROM booking_participants
          WHERE tenant_id = ? AND booking_group = ?`,
      )
      .get(tenantId, b.bookingGroup) as { n: number } | undefined;
    // If we have participant rows, that count is the authoritative total
    // (primary booker is included in the participants table). If not, fall
    // back to 1 (just the primary).
    return row && row.n > 0 ? row.n : 1;
  } catch {
    return 1;
  }
}

// availabilityForRange returns a 30-min slot grid per date for a tenant.
//
// When `forLessonType` is provided (the customer has picked a lesson type),
// the grid uses that lesson type's group/solo semantics:
//   - Solo: slot.booked = true if ANY booking holds the slot.
//   - Group: slot.booked = true ONLY when occupants ≥ capacity. While the
//     slot is still bookable, we also expose `remainingSpots` so the UI can
//     surface 'X left' / 'Last spot!' treatments. Slots already held by a
//     DIFFERENT lesson type are always booked (the coach is busy).
//
// `isGroupFilter` (legacy bool path) is preserved for callers that haven't
// migrated to passing the full lesson type — it still filters by window mode.
function availabilityForRange(
  tenantId: number,
  startDate: string,
  endDate: string,
  forLessonType: { id: number; capacity: number; isGroup: boolean; durationMin: number } | null = null,
  adminUserId?: number,
) {
  const isGroupFilter = forLessonType ? forLessonType.isGroup : null;
  // When scoped to a coach, only consider bookings for that coach.
  const allBookings = storage.getBookingsInRange(tenantId, startDate + "T00:00", endDate + "T23:59");
  const all = adminUserId !== undefined
    ? allBookings.filter(b => b.adminUserId === adminUserId)
    : allBookings;
  const lessonTypeDurations = new Map<number, number>();
  const lessonTypeIsGroup = new Map<number, boolean>();
  for (const lt of storage.listLessonTypes(tenantId)) {
    lessonTypeDurations.set(lt.id, lt.durationMin);
    lessonTypeIsGroup.set(lt.id, ((lt as any).isGroup ?? 0) === 1);
  }
  // Per-slot:
  //   bookedSet: ANY booking holds it (regardless of lesson type).
  //   sameTypeOccupants: total participants for THIS lesson type at this slot.
  //   anyOtherType: a booking of a DIFFERENT lesson type holds it.
  const bookedSet = new Set<string>();
  const sameTypeOccupants = new Map<string, number>();
  const anyOtherType = new Set<string>();
  for (const b of all) {
    const dur = b.lessonTypeId != null ? (lessonTypeDurations.get(b.lessonTypeId) ?? SLOT_MIN) : SLOT_MIN;
    const startMs = new Date(b.start + ":00").getTime();
    const blockCount = Math.max(1, Math.ceil(dur / SLOT_MIN));
    const ptCount = countParticipantsOnBooking(tenantId, b);
    for (let i = 0; i < blockCount; i++) {
      const slotMs = startMs + i * SLOT_MIN * 60_000;
      const d = new Date(slotMs);
      const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      bookedSet.add(iso);
      if (forLessonType != null && b.lessonTypeId === forLessonType.id) {
        sameTypeOccupants.set(iso, (sameTypeOccupants.get(iso) ?? 0) + ptCount);
      } else if (forLessonType != null) {
        anyOtherType.add(iso);
      }
    }
  }
  const days: { date: string; slots: { start: string; booked: boolean; remainingSpots?: number }[] }[] = [];
  let cur = startDate;
  const ltDuration = forLessonType?.durationMin ?? SLOT_MIN;
  while (cur <= endDate) {
    const slots = slotsForDate(tenantId, cur, isGroupFilter, adminUserId, ltDuration).map(s => {
      if (!forLessonType) {
        // No lesson type picked — use the legacy semantics (admin view).
        return { start: s, booked: bookedSet.has(s) };
      }
      // Slot held by another lesson type — always blocked.
      if (anyOtherType.has(s)) return { start: s, booked: true };
      if (forLessonType.isGroup) {
        const occupants = sameTypeOccupants.get(s) ?? 0;
        const remaining = Math.max(0, forLessonType.capacity - occupants);
        return { start: s, booked: remaining === 0, remainingSpots: remaining };
      }
      // Solo lesson type: any prior booking blocks the slot.
      return { start: s, booked: bookedSet.has(s) };
    });
    days.push({ date: cur, slots });
    cur = addDays(cur, 1);
  }
  return days;
}

// --- gap detection ---
type GapWarning = {
  date: string;
  gapStart: string;
  gapEnd: string;
  gapMinutes: number;
  message: string;
  suggestion?: { from: string; to: string; reason: string };
};

function detectGaps(tenantId: number, selectedSlots: string[], excludeBookingIds: number[] = []): GapWarning[] {
  const warnings: GapWarning[] = [];
  const byDate = new Map<string, string[]>();
  for (const s of selectedSlots) {
    if (!byDate.has(isoDate(s))) byDate.set(isoDate(s), []);
    byDate.get(isoDate(s))!.push(s);
  }
  for (const [date, userSlots] of byDate) {
    const windows = openWindowsForDate(tenantId, date);
    if (!windows.length) continue;
    const existing = storage.getBookingsInRange(tenantId, date + "T00:00", date + "T23:59")
      .filter(b => !excludeBookingIds.includes(b.id))
      .map(b => b.start);
    const allBooked = new Set<string>([...existing, ...userSlots]);
    for (const w of windows) {
      const busy: { s: number; e: number }[] = [];
      for (const s of allBooked) {
        if (isoDate(s) !== date) continue;
        const m = isoToMin(s);
        if (m >= w.start && m + SLOT_MIN <= w.end) busy.push({ s: m, e: m + SLOT_MIN });
      }
      if (!busy.length) continue;
      busy.sort((a, b) => a.s - b.s);
      const merged: { s: number; e: number }[] = [];
      for (const b of busy) {
        const last = merged[merged.length - 1];
        if (last && b.s <= last.e) last.e = Math.max(last.e, b.e);
        else merged.push({ ...b });
      }
      const opens: { s: number; e: number; leftBusy: boolean; rightBusy: boolean }[] = [];
      if (merged[0].s > w.start) opens.push({ s: w.start, e: merged[0].s, leftBusy: false, rightBusy: true });
      for (let i = 0; i < merged.length - 1; i++) {
        opens.push({ s: merged[i].e, e: merged[i + 1].s, leftBusy: true, rightBusy: true });
      }
      const lastB = merged[merged.length - 1];
      if (lastB.e < w.end) opens.push({ s: lastB.e, e: w.end, leftBusy: true, rightBusy: false });
      for (const o of opens) {
        const gap = o.e - o.s;
        if (gap <= 0) continue;
        if (o.leftBusy && o.rightBusy && gap <= MAX_GAP_MIN) {
          const slotBeforeGap = toIso(date, minToTime(o.s - SLOT_MIN));
          const slotAfterGap = toIso(date, minToTime(o.e));
          const warning: GapWarning = {
            date,
            gapStart: toIso(date, minToTime(o.s)),
            gapEnd: toIso(date, minToTime(o.e)),
            gapMinutes: gap,
            message: `On ${formatDateLong(date)} there'd be a ${gap}-min gap from ${formatTime(minToTime(o.s))} to ${formatTime(minToTime(o.e))}.`,
          };
          const cands: { from: string; to: string }[] = [];
          if (userSlots.includes(slotBeforeGap)) {
            const newStart = o.s - SLOT_MIN + gap;
            if (newStart + SLOT_MIN <= w.end) {
              const to = toIso(date, minToTime(newStart));
              if (!allBooked.has(to) || to === slotBeforeGap) cands.push({ from: slotBeforeGap, to });
            }
          }
          if (userSlots.includes(slotAfterGap)) {
            const newStart = o.e - gap;
            if (newStart >= w.start) {
              const to = toIso(date, minToTime(newStart));
              if (!allBooked.has(to) || to === slotAfterGap) cands.push({ from: slotAfterGap, to });
            }
          }
          if (cands.length) {
            const c = cands[0];
            warning.suggestion = {
              from: c.from, to: c.to,
              reason: `Move ${formatTime(c.from.split("T")[1])} → ${formatTime(c.to.split("T")[1])} to close the gap.`,
            };
          }
          warnings.push(warning);
        }
      }
    }
  }
  return warnings;
}

// --- ICS generation ---
function icsForBookings(rows: BookingWithProfile[]) {
  const sorted = [...rows].sort((a, b) => a.start.localeCompare(b.start));
  // merge consecutive same-group slots into single events
  const events: { startIso: string; endMin: number; row: BookingWithProfile }[] = [];
  for (const r of sorted) {
    const last = events[events.length - 1];
    const startMin = isoToMin(r.start);
    if (last && isoDate(last.startIso) === isoDate(r.start) && last.endMin === startMin && last.row.bookingGroup === r.bookingGroup) {
      last.endMin = startMin + SLOT_MIN;
    } else {
      events.push({ startIso: r.start, endMin: startMin + SLOT_MIN, row: r });
    }
  }
  const lines: string[] = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CoachSkinner//Lessons//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
  ];
  const manageUrl = (process.env.PUBLIC_SITE_URL || getSetting("publicSiteUrl") || "").replace(/\/$/, "") + "/#/my-appointments";
  for (const ev of events) {
    const date = isoDate(ev.startIso);
    const dtStart = date.replace(/-/g, "") + "T" + ev.startIso.split("T")[1].replace(":", "") + "00";
    const dtEnd = date.replace(/-/g, "") + "T" + minToTime(ev.endMin).replace(":", "") + "00";
    const uid = `${ev.row.bookingGroup}-${ev.startIso}@coachben`;
    const summary = `Softball lesson — ${ev.row.playerName}`;
    const desc = [
      `Player: ${ev.row.playerName}`,
      `Parent: ${ev.row.parentName}`,
      `Phone: ${ev.row.phone}`,
      ev.row.notes ? `Notes: ${ev.row.notes}` : "",
      `Manage / reschedule (up to 24h before): ${manageUrl}`,
    ].filter(Boolean).join("\\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:${desc}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function isInsideLeadWindow(iso: string, leadMs: number): boolean {
  const start = isoToLocalDate(iso).getTime();
  return start - Date.now() < leadMs;
}

function isBeyondMaxWindow(iso: string, maxWindowMs: number): boolean {
  const start = isoToLocalDate(iso).getTime();
  return start - Date.now() > maxWindowMs;
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // --- Health check (used by Render) ---
  app.get("/healthz", (_req, res) => res.status(200).send("ok"));

  // Temporary tenant-resolution diagnostic.  Returns the resolved tenantId
  // and tenant slug for the incoming Host header.  Used during the
  // multi-tenant rollout to verify subdomain + custom-domain routing.
  // TODO: remove once tenant-aware routes are fully shipped.
  app.get("/api/_tenant", (req, res) => {
    res.json({
      host: req.headers.host || null,
      tenantId: req.tenantId ?? null,
      slug: req.tenant?.slug ?? null,
      name: req.tenant?.name ?? null,
      sport: req.tenant?.sport ?? null,
      primaryColor: req.tenant?.primary_color ?? null,
      logoPath: req.tenant?.logo_path ?? null,
      heroPath: req.tenant?.hero_path ?? null,
      heroFocalX: req.tenant?.hero_focal_x ?? 50,
      heroFocalY: req.tenant?.hero_focal_y ?? 50,
      heroZoom: req.tenant?.hero_zoom ?? 100,
      tagline: req.tenant?.tagline ?? null,
      about: req.tenant?.about ?? null,
      contactPhone: req.tenant?.contact_phone ?? null,
      contactEmail: req.tenant?.contact_email ?? null,
      paymentNote: req.tenant?.payment_note ?? "",
      maxBookingDays: req.tenant?.max_booking_days ?? 30,
      minLeadHours: req.tenant?.min_lead_hours ?? 24,
      contactLocation: req.tenant?.contact_location ?? null,
      bookerLabel: req.tenant?.booker_label ?? null,
      attendeeLabel: req.tenant?.attendee_label ?? null,
      plan: req.tenant?.plan ?? null,
      trialEndsAt: req.tenant?.trial_ends_at ?? null,
    });
  });

  // TEMP: Admin DB backup endpoint (pre-multi-tenant migration safety).
  // Remove after final migration deploy. Uses better-sqlite3's .backup() method
  // for a WAL-consistent single-file snapshot.
  app.get("/api/admin/db-backup", requireAdmin, async (_req, res) => {
    try {
      const tmpPath = `/tmp/backup-${Date.now()}.db`;
      // @ts-ignore - .backup() exists on better-sqlite3 Database instances
      await (sqlite as any).backup(tmpPath);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="data-backup-${Date.now()}.db"`);
      const stream = fs.createReadStream(tmpPath);
      stream.pipe(res);
      stream.on("close", () => { try { fs.unlinkSync(tmpPath); } catch {} });
    } catch (err: any) {
      res.status(500).json({ error: "backup failed", detail: String(err?.message || err) });
    }
  });

  // --- Auth ---
  app.post("/api/auth/login", (req, res) => {
    const tenantId = requireTenantId(req, res);
    if (tenantId === null) return;
    const { phone, password } = req.body || {};
    if (typeof phone !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "phone and password required" });
    }
    const result = checkLogin(phone, password, tenantId);
    if (!result.ok) return res.status(401).json({ error: "Invalid phone or password" });
    setSessionCookie(res, result.token);
    res.json({ ok: true });
  });

  // --- Forgot password ---
  // Sends a one-time reset link to the tenant's contact_email.  Always responds
  // 200 OK regardless of whether the admin exists (no user enumeration).
  // Identifier can be a phone number or an email address; we'll try both.
  app.post("/api/auth/forgot", async (req, res) => {
    const tenantId = requireTenantId(req, res);
    if (tenantId === null) return;
    const identifier = String(req.body?.identifier || "").trim();
    if (!identifier) return res.json({ ok: true });
    try {
      const result = createResetToken(tenantId, identifier);
      if (result) {
        const tenant = req.tenant;
        const slug = tenant?.slug || "";
        // Reset URL points back to this subdomain with token in the query string.
        // App uses hash routing, but the page parses window.location.search.
        const proto = (req.headers["x-forwarded-proto"] as string) || "https";
        const host = req.headers.host || `${slug}.lessonspot.app`;
        const resetUrl = `${proto}://${host}/?token=${encodeURIComponent(result.token)}#/reset`;
        // Pick the destination email: use the matched admin's own email first;
        // fall back to tenant contact_email, then the identifier if it looks like an email.
        let to = (result.email || "").trim();
        if (!to) to = String(tenant?.contact_email || "").trim();
        if (!to && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identifier)) to = identifier;
        if (to) {
          const name = tenant?.name || "LessonSpot";
          const subject = `Reset your ${name} admin password`;
          const html = `
            <p>Hi,</p>
            <p>We received a request to reset the admin password for <strong>${name}</strong>.</p>
            <p>Click the link below to choose a new password. This link expires in 1 hour and can only be used once.</p>
            <p><a href="${resetUrl}" style="display:inline-block;padding:10px 16px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:6px">Reset password</a></p>
            <p style="color:#666;font-size:12px">Or paste this link into your browser:<br>${resetUrl}</p>
            <hr>
            <p style="color:#666;font-size:12px">If you didn't request this, you can safely ignore this email.</p>
          `;
          const text = `Reset your ${name} admin password\n\nOpen this link to choose a new password (expires in 1 hour, single use):\n${resetUrl}\n\nIf you didn't request this, ignore this email.`;
          const sendResult = await sendEmail({ to, subject, html, text });
          if (!sendResult.ok) {
            console.error("forgot-password email failed:", sendResult.error);
          }
        } else {
          console.warn(`forgot-password: no destination email for tenant ${tenantId}`);
        }
      }
    } catch (err: any) {
      console.error("forgot-password error:", err?.message || err);
    }
    // Always return ok — no user enumeration.
    res.json({ ok: true });
  });

  // --- Reset password ---
  // Consumes a reset token and sets a new password.  All sessions for the
  // tenant are invalidated, so the user must log in again with the new password.
  app.post("/api/auth/reset", (req, res) => {
    const token = String(req.body?.token || "");
    const password = String(req.body?.password || "");
    if (!token) return res.status(400).json({ ok: false, error: "Reset link is missing or invalid." });
    if (!password || password.length < 6) {
      return res.status(400).json({ ok: false, error: "Password must be at least 6 characters." });
    }
    const result = consumeResetToken(token, password);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true });
  });

  // ===== Self-serve signup =====
  // Public endpoints (no requireAdmin) — anyone can create a new tenant.
  // Both endpoints are intentionally rate-limit-free at this stage; we'll add
  // a tarpit if abuse shows up.
  app.post("/api/signup/check-slug", (req, res) => {
    const slug = String(req.body?.slug || "");
    res.json(checkSlug(slug));
  });

  // Marketing demo-request leads.  Used by the /demo landing page on the apex.
  // Soft-gate form: visitor can see the live demo link without filling this out,
  // but if they do, we email Skinner so he can follow up personally.
  app.post("/api/demo-request", async (req, res) => {
    const body = req.body || {};
    const name = String(body.name || "").trim().slice(0, 200);
    const email = String(body.email || "").trim().slice(0, 200);
    const phone = String(body.phone || "").trim().slice(0, 50);
    const message = String(body.message || "").trim().slice(0, 2000);
    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required" });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email" });
    }
    const to = process.env.DEMO_LEAD_TO || "skinnerbenjamin@yahoo.com";
    const subject = `New LessonSpot demo request from ${name}`;
    const escape = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = `
      <h2>New demo request</h2>
      <p><strong>Name:</strong> ${escape(name)}</p>
      <p><strong>Email:</strong> <a href="mailto:${escape(email)}">${escape(email)}</a></p>
      ${phone ? `<p><strong>Phone:</strong> ${escape(phone)}</p>` : ""}
      ${message ? `<p><strong>Message:</strong><br>${escape(message).replace(/\n/g, "<br>")}</p>` : ""}
      <hr>
      <p style="color:#666;font-size:12px">Sent from lessonspot.app/#/demo</p>
    `;
    const text =
      `New demo request\n\n` +
      `Name: ${name}\nEmail: ${email}\n` +
      (phone ? `Phone: ${phone}\n` : "") +
      (message ? `\nMessage:\n${message}\n` : "") +
      `\nFrom lessonspot.app/#/demo`;
    const result = await sendEmail({ to, subject, html, text });
    if (!result.ok) {
      console.error("demo-request email failed:", result.error);
      return res.status(500).json({ error: "Email failed to send" });
    }
    res.json({ ok: true, dryRun: !!result.dryRun });
  });

  app.post("/api/signup", (req, res) => {
    const body = req.body || {};
    const result = createTenantAndOwner({
      name: String(body.name || ""),
      slug: String(body.slug || ""),
      email: String(body.email || ""),
      phone: String(body.phone || ""),
      password: String(body.password || ""),
      sport: body.sport ? String(body.sport) : undefined,
    });
    if (!result.ok) {
      return res.status(400).json({ error: result.error, field: result.field });
    }
    // Set the session cookie for the *current* host.  The frontend will then
    // redirect to `<slug>.lessonspot.app/admin` where the cookie won't apply
    // (different host), and the new owner will need to log in once.  In dev
    // (localhost) the cookie stays valid because the host doesn't change.
    setSessionCookie(res, result.sessionToken);
    // We also return the raw session token so the redirect URL can hand it off
    // to the new subdomain (cookies set on lessonspot.app don't reach
    // <slug>.lessonspot.app).  The new subdomain calls POST /api/auth/handoff
    // with this token and re-sets the cookie on its own host.  Hash routing is
    // used by the app, so we steer the URL at #/admin so it actually lands on
    // the admin page instead of the public Book page.
    res.json({
      ok: true,
      slug: result.slug,
      tenantId: result.tenantId,
      trialEndsAt: result.trialEndsAt,
      sessionToken: result.sessionToken,
      adminUrl: `https://${result.slug}.lessonspot.app/?login=${result.sessionToken}#/admin`,
    });
  });

  // One-shot cross-subdomain login.  Signup hands the session token to the
  // new subdomain via ?login=TOKEN; the SPA POSTs it here to swap it for a
  // cookie on the new host.  We verify the token belongs to the tenant
  // currently being served (so a stolen token can't be planted on a
  // different tenant's site).
  app.post("/api/auth/handoff", (req, res) => {
    const tenantId = requireTenantId(req, res);
    if (tenantId === null) return;
    const token = String(req.body?.token || "");
    if (!token) return res.status(400).json({ error: "token required" });
    const sessionTenantId = getSessionTenantId(token);
    if (sessionTenantId === null) return res.status(401).json({ error: "invalid token" });
    if (sessionTenantId !== tenantId) return res.status(403).json({ error: "wrong tenant" });
    setSessionCookie(res, token);
    res.json({ ok: true });
  });

  // Superadmin: delete a tenant by id.  Locked to the Coach Skinner owner
  // (tenant 1, phone 9079527860) -- this is a one-off cleanup tool for test
  // signups, not a multi-tenant feature.  Cascades through all tenant-scoped
  // tables so the row removal is total.
  app.post("/api/superadmin/delete-tenant", requireAdmin, (req, res) => {
    const token = getTokenFromReq(req);
    const sessTenant = getSessionTenantId(token);
    if (sessTenant !== 1) return res.status(403).json({ error: "superadmin only" });
    const targetId = Number(req.body?.tenantId);
    if (!Number.isFinite(targetId) || targetId <= 1) {
      return res.status(400).json({ error: "invalid tenantId (cannot be 1)" });
    }
    try {
      const Database = require("better-sqlite3");
      const db = new Database(process.env.DB_PATH || "data.db");
      // Sanity: confirm caller is the Skinner owner.
      const ownerRow: any = db.prepare(`SELECT phone FROM admin_users WHERE tenant_id=1 AND is_owner=1 LIMIT 1`).get();
      // (Not strictly needed once sessTenant===1, but belt-and-suspenders.)
      if (!ownerRow) return res.status(403).json({ error: "no owner row" });

      const tx = db.transaction((id: number) => {
        // Order matters: child tables first, then parent.
        const tables = [
          "waitlist", "bookings", "availability", "availability_overrides",
          "lesson_types", "resources", "resource_categories",
          "admin_sessions", "admin_users", "settings",
        ];
        const counts: Record<string, number> = {};
        for (const t of tables) {
          try {
            const r = db.prepare(`DELETE FROM ${t} WHERE tenant_id = ?`).run(id);
            counts[t] = r.changes;
          } catch (e: any) {
            // Table may not have tenant_id (e.g. legacy admin_credentials); skip.
            counts[t] = -1;
          }
        }
        const r = db.prepare(`DELETE FROM tenants WHERE id = ?`).run(id);
        counts["tenants"] = r.changes;
        return counts;
      });
      const counts = tx(targetId);
      db.close();
      res.json({ ok: true, tenantId: targetId, deleted: counts });
    } catch (err: any) {
      console.error("[delete-tenant] failed:", err);
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // Superadmin: list all tenants (for the same one-off cleanup workflow).
  app.get("/api/superadmin/tenants", requireAdmin, (req, res) => {
    const token = getTokenFromReq(req);
    const sessTenant = getSessionTenantId(token);
    if (sessTenant !== 1) return res.status(403).json({ error: "superadmin only" });
    try {
      const Database = require("better-sqlite3");
      const db = new Database(process.env.DB_PATH || "data.db");
      const rows = db.prepare(`SELECT id, slug, name, contact_email, contact_phone, plan, created_at FROM tenants ORDER BY id`).all();
      db.close();
      res.json({ tenants: rows });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    logout(getTokenFromReq(req));
    clearSessionCookie(res);
    res.json({ ok: true });
  });
  app.get("/api/auth/me", (req, res) => {
    res.json({ authed: isAuthed(req) });
  });
  app.post("/api/auth/change", requireAdmin, (req, res) => {
    const { phone, password, currentPassword } = req.body || {};
    // require current password to confirm changes
    if (typeof currentPassword !== "string") return res.status(400).json({ error: "current password required" });
    const currentPhone = getAdminPhone();
    const tenantId = req.tenantId ?? 1;
    const verify = checkLogin(currentPhone, currentPassword, tenantId);
    if (!verify.ok) return res.status(401).json({ error: "Current password is incorrect" });
    // checkLogin created a session as a side-effect; we don't need it
    logout(verify.token);
    const updates: { phone?: string; password?: string } = {};
    if (typeof phone === "string" && phone.trim()) updates.phone = phone.trim();
    if (typeof password === "string" && password.length >= 6) updates.password = password;
    if (typeof password === "string" && password.length > 0 && password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    updateCredentials(updates);
    // password change invalidates session; sign user out
    if (updates.password) clearSessionCookie(res);
    res.json({ ok: true, signedOut: !!updates.password });
  });

  // Public list of coaches for this tenant (lesson-givers only, no email/phone)
  app.get("/api/coaches", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const coaches = sqlite.prepare(
      `SELECT id, name, color FROM admin_users WHERE tenant_id=? AND gives_lessons=1 AND email != '' ORDER BY id`
    ).all(tenantId) as { id: number; name: string; color: string | null }[];
    res.json(coaches.map(c => ({ id: c.id, name: c.name || "", color: c.color || "" })));
  });

  // Availability
  app.get("/api/availability", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    // Optional coachId — defaults to solo coach for back-compat
    let adminUserId: number | undefined;
    const coachIdRaw = req.query.coachId;
    if (coachIdRaw !== undefined && coachIdRaw !== "") {
      adminUserId = Number(coachIdRaw);
    } else {
      const solo = getSoloCoach(tenantId);
      if (solo) adminUserId = solo.id;
    }
    res.json({ weekly: storage.getAvailability(tenantId, adminUserId), overrides: storage.getDateOverrides(tenantId, adminUserId) });
  });
  app.put("/api/availability", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    // coachId required in body for multi-coach; if absent, fall back to solo coach
    let adminUserId: number | undefined;
    const coachIdBody = req.body?.coachId;
    if (coachIdBody !== undefined && coachIdBody !== null && coachIdBody !== "") {
      const resolved = resolveCoachId(req, res, tenantId, { required: false, requireGivesLessons: false });
      if (resolved === null) return; // error already sent
      adminUserId = resolved ?? undefined;
    } else {
      const solo = getSoloCoach(tenantId);
      if (solo) adminUserId = solo.id;
    }
    const parsed = z.array(insertAvailabilitySchema).safeParse(req.body?.rows ?? req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    storage.setAvailability(tenantId, parsed.data, adminUserId);
    res.json({ ok: true });
  });
  app.post("/api/overrides", requireAdmin, async (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    // Resolve coach for the override
    let overrideAdminUserId: number | undefined;
    const coachIdBody = req.body?.coachId;
    if (coachIdBody !== undefined && coachIdBody !== null && coachIdBody !== "") {
      const resolved = resolveCoachId(req, res, tenantId, { required: false, requireGivesLessons: false });
      if (resolved === null) return;
      overrideAdminUserId = resolved ?? undefined;
    } else {
      const solo = getSoloCoach(tenantId);
      if (solo) overrideAdminUserId = solo.id;
    }
    const parsed = insertDateOverrideSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const override = storage.addDateOverride(tenantId, parsed.data, overrideAdminUserId);

    // If this is a 'closed' blackout, cancel every booking on that date and email the parents.
    // Cancellation notices are EMAIL ONLY — SMS is intentionally not used here even if the
    // tenant's reminderChannel is "sms" or "both", because SMS delivery is unreliable
    // (A2P registration, Twilio config) and silently failing leaves families uninformed.
    const cancelled: { id: number; start: string; playerName: string; parentName: string; phone: string; email: string; notified: boolean; notifyError?: string }[] = [];
    if (parsed.data.type === "closed") {
      const date = parsed.data.date;
      const onDate = storage.getBookingsInRange(tenantId, date + "T00:00", date + "T23:59")
        .map(b => storage.expandBooking(tenantId, b))
        .sort((a, b) => a.start.localeCompare(b.start));
      // group by profileId so each parent gets ONE notification covering all of their cancelled sessions
      const byProfile = new Map<number, typeof onDate>();
      for (const b of onDate) {
        if (!byProfile.has(b.profileId)) byProfile.set(b.profileId, []);
        byProfile.get(b.profileId)!.push(b);
      }
      const coachName = getSetting("coachName") || "Coach Skinner";
      const dateLong = formatDateLong(date);
      const manageUrl = (process.env.PUBLIC_SITE_URL || getSetting("publicSiteUrl") || "").replace(/\/$/, "") + "/#/my-appointments";
      for (const [_profileId, rows] of byProfile) {
        const phone = rows[0].phone;
        const email = rows[0].email;
        const times = rows.map(r => formatTime(r.start.split("T")[1])).join(", ");
        const playerNames = Array.from(new Set(rows.map(r => r.playerName))).join(" & ");
        const msg = `Really sorry — ${coachName} has to cancel lessons on ${dateLong}. Affected: ${playerNames} at ${times}. Please reach out to reschedule.`;

        let notified = false;
        let notifyError: string | undefined;
        if (email) {
          const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f1a14;"><div style="max-width:560px;margin:0 auto;padding:24px 16px;"><div style="background:#ffffff;border-radius:12px;padding:24px;"><div style="font-size:20px;font-weight:600;color:#a33;margin-bottom:12px;">Lesson cancelled — ${dateLong}</div><p style="font-size:16px;line-height:1.5;margin:0 0 12px 0;">${msg}</p><p style="font-size:14px;color:#525f57;margin:8px 0 24px 0;">Sessions cancelled: <b>${playerNames}</b> at <b>${times}</b>.</p><div style="text-align:center;margin:24px 0;"><a href="${manageUrl}" style="display:inline-block;background:#1f5a37;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;">Book a different time</a></div></div></div></body></html>`;
          const r = await sendEmail({
            to: email,
            subject: `Cancelled: ${dateLong} lesson with ${coachName}`,
            html,
            text: `${msg}\n\nBook a different time: ${manageUrl}`,
          });
          if (r.ok) notified = true; else notifyError = `email: ${r.error}`;
        } else {
          notifyError = "no email on file";
        }
        for (const r of rows) {
          cancelRemindersForBooking(r.id);
          storage.deleteBooking(tenantId, r.id);
          cancelled.push({
            id: r.id, start: r.start, playerName: r.playerName, parentName: r.parentName,
            phone, email,
            notified, notifyError,
          });
        }
      }
    }
    res.json({ override, cancelledBookings: cancelled });
  });
  app.delete("/api/overrides/:id", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    storage.deleteDateOverride(tenantId, Number(req.params.id));
    res.json({ ok: true });
  });

  // Slot list (public).
  // Optional ?lessonTypeId= filters slots so customers only see windows that
  // match the selected lesson type's group flag (solo vs group). When omitted,
  // returns all slots regardless of window mode (used by admin views).
  // Optional ?coachId= scopes slots to a specific coach. Defaults to the solo
  // coach when only one lesson-giving coach exists (back-compat).
  app.get("/api/slots", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const start = String(req.query.start || "");
    const end = String(req.query.end || "");
    if (!start || !end) return res.status(400).json({ error: "start and end required" });
    // Cap end at this tenant's max booking window for non-admin requests
    const isAdmin = !!(req as any).session?.admin;
    const maxWindowMs = tenantMaxBookingWindowMs(req);
    let effectiveEnd = end;
    if (!isAdmin) {
      const maxEndMs = Date.now() + maxWindowMs;
      const requestedEndMs = new Date(end).getTime();
      if (requestedEndMs > maxEndMs) {
        effectiveEnd = new Date(maxEndMs).toISOString();
      }
    }
    // Resolve coachId: explicit > solo-coach fallback > undefined (all coaches)
    let slotsAdminUserId: number | undefined;
    const coachIdParam = req.query.coachId;
    if (coachIdParam !== undefined && coachIdParam !== "") {
      slotsAdminUserId = Number(coachIdParam);
    } else {
      const solo = getSoloCoach(tenantId);
      if (solo) slotsAdminUserId = solo.id;
    }
    // Resolve full lesson type from optional lessonTypeId query param. When
    // present, the slot grid filters by window mode AND computes per-slot
    // remainingSpots for group lessons.
    let forLessonType: { id: number; capacity: number; isGroup: boolean; durationMin: number } | null = null;
    const ltIdParam = req.query.lessonTypeId;
    if (ltIdParam) {
      const ltId = Number(ltIdParam);
      if (Number.isFinite(ltId)) {
        const lt = storage.getLessonTypeById(tenantId, ltId);
        if (lt) {
          forLessonType = {
            id: lt.id,
            capacity: lt.capacity ?? 1,
            isGroup: ((lt as any).isGroup ?? 0) === 1,
            durationMin: lt.durationMin,
          };
        }
      }
    }
    res.json({
      days: availabilityForRange(tenantId, start, effectiveEnd, forLessonType, slotsAdminUserId),
      maxBookingDays: tenantMaxBookingDays(req),
      minLeadHours: tenantMinLeadHours(req),
      // Phase 2: surface tenant-level toggles so the booking page can decide
      // whether to render 'Join waitlist' on full slots.
      waitlistEnabled: (getSetting("waitlistEnabled") || "1") === "1",
    });
  });

  // Profiles
  app.get("/api/profile/:phone", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const p = storage.getProfileByPhone(tenantId, req.params.phone);
    if (!p) return res.status(404).json({ error: "Not found" });
    res.json(p);
  });
  app.post("/api/profile", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const parsed = insertProfileSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    res.json(storage.upsertProfile(tenantId, parsed.data));
  });

  // Gap check (used at review step)
  app.post("/api/check-gaps", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const parsed = z.object({
      slots: z.array(z.string()),
      excludeBookingIds: z.array(z.number()).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid" });
    res.json({ warnings: detectGaps(tenantId, parsed.data.slots, parsed.data.excludeBookingIds ?? []) });
  });

  // Checkout
  app.post("/api/bookings", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    // Trial enforcement: once a tenant's free trial expires and they haven't
    // upgraded, lock new public bookings. Admin/owner of the tenant can still
    // book (so they can keep using the calendar privately while paying up).
    const isAdmin = isAdminReq(req);
    if (!isAdmin && req.tenant?.plan === "trial" && req.tenant?.trial_ends_at && Date.now() > req.tenant.trial_ends_at) {
      return res.status(402).json({
        error: "This booking site's free trial has ended. The coach needs to subscribe to keep accepting bookings.",
        code: "TRIAL_EXPIRED",
      });
    }
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { slots: rawSlots, phone, email, parentName, playerName, notes, lessonTypeId, participants, kids } = parsed.data;
    // Normalize slot inputs: legacy strings or new { start, kidIndex } objects.
    // kids[0] is conventionally the primary booker (`playerName`). When the
    // client supplied kids[], we'll create one synthetic-phone profile per
    // kid index >0 and route per-slot bookings to that profile.
    const slotsAssigned = rawSlots.map(s => typeof s === "string"
      ? { start: s, kidIndex: 0 }
      : { start: s.start, kidIndex: s.kidIndex ?? 0 });
    const slots = slotsAssigned.map(s => s.start);

    // Resolve which coach this booking is for. Defaults to solo coach for back-compat.
    let bookingAdminUserId: number | undefined;
    const coachIdInBody = req.body?.coachId;
    if (coachIdInBody !== undefined && coachIdInBody !== null && coachIdInBody !== "") {
      const coachNum = Number(coachIdInBody);
      if (!Number.isFinite(coachNum)) return res.status(400).json({ error: "coachId must be a number" });
      const coachRow = sqlite.prepare(
        `SELECT id FROM admin_users WHERE id=? AND tenant_id=? AND gives_lessons=1 LIMIT 1`
      ).get(coachNum, tenantId) as { id: number } | undefined;
      if (!coachRow) return res.status(400).json({ error: "This coach is no longer accepting bookings" });
      bookingAdminUserId = coachNum;
    } else {
      const solo = getSoloCoach(tenantId);
      if (solo) bookingAdminUserId = solo.id;
    }

    // upsert profile (primary booker)
    const profile = storage.upsertProfile(tenantId, { phone: normalizePhone(phone), email, parentName, playerName, notes });
    // Merge kid names into the profile so we can show them next visit.
    if (kids.length > 0) {
      storage.mergeKidsOnProfile(tenantId, profile.id, kids.map(k => k.playerName));
    }
    // Customers can't book inside the lead window or beyond the max booking
    // window. Admins bypass both. Both values are per-tenant (set in Branding).
    const leadMs = tenantMinLeadMs(req);
    const leadHrs = tenantMinLeadHours(req);
    const maxDays = tenantMaxBookingDays(req);
    const maxMs = tenantMaxBookingWindowMs(req);
    if (!isAdmin && slots.some(s => isInsideLeadWindow(s, leadMs))) {
      return res.status(400).json({
        error: leadHrs === 0
          ? "Bookings must be in the future."
          : `Bookings must be at least ${leadHrs} hour${leadHrs === 1 ? "" : "s"} in advance.`,
      });
    }
    if (!isAdmin && slots.some(s => isBeyondMaxWindow(s, maxMs))) {
      return res.status(400).json({ error: `Bookings can be made up to ${maxDays} days in advance.` });
    }
    // Resolve lesson type and enforce capacity for group bookings.
    let resolvedLessonTypeId: number | null = null;
    let lessonCapacity = 1;
    let resolvedIsGroup = false;
    if (lessonTypeId) {
      const lt = storage.getLessonTypeById(tenantId, lessonTypeId);
      if (!lt) return res.status(400).json({ error: "Invalid lesson type for this site." });
      if (lt.active !== 1 && !isAdmin) {
        return res.status(400).json({ error: "That lesson type isn't currently bookable." });
      }
      // Validate lesson type belongs to the assigned coach (when both are provided)
      if (bookingAdminUserId !== undefined && (lt as any).adminUserId !== undefined) {
        const ltAdminId = (lt as any).adminUserId;
        if (ltAdminId !== null && ltAdminId !== bookingAdminUserId) {
          return res.status(400).json({ error: "That lesson type is not offered by the selected coach." });
        }
      }
      resolvedLessonTypeId = lt.id;
      lessonCapacity = lt.capacity;
      resolvedIsGroup = ((lt as any).isGroup ?? 0) === 1;
    }
    // Window-mode gate: every requested slot must fall inside an open window
    // whose mode is compatible with the lesson type's isGroup flag, AND the
    // full lesson duration must fit inside the window (a 60-min lesson can't
    // start at 7:30 PM in a 4-8 PM window).
    // Admins can bypass this so they can manually slot in special cases.
    if (!isAdmin && resolvedLessonTypeId != null) {
      const ltForCheck = storage.getLessonTypeById(tenantId, resolvedLessonTypeId);
      const ltDur = ltForCheck?.durationMin ?? SLOT_MIN;
      for (const s of slots) {
        const date = isoDate(s);
        const startMin = isoToMin(s);
        const wins = openWindowsForDate(tenantId, date, bookingAdminUserId);
        const ok = wins.some(w => {
          if (startMin < w.start || startMin + ltDur > w.end) return false;
          if (w.mode === "both") return true;
          return resolvedIsGroup ? w.mode === "group" : w.mode === "solo";
        });
        if (!ok) {
          return res.status(400).json({
            error: resolvedIsGroup
              ? "That time slot isn't open for group lessons. Please pick a group-eligible slot that fits the full lesson length."
              : "That time slot isn't open for solo lessons. Please pick a solo-eligible slot that fits the full lesson length.",
          });
        }
      }
    }
    const totalParticipants = 1 + participants.length;
    if (totalParticipants > lessonCapacity) {
      return res.status(400).json({
        error: `This lesson allows up to ${lessonCapacity} participant${lessonCapacity === 1 ? "" : "s"}. You tried to book ${totalParticipants}.`,
      });
    }
    // Duration-aware collision check.
    // The new booking's lesson duration may span multiple SLOT_MIN windows.
    // We expand each requested slot into the set of SLOT_MIN windows it occupies, then
    // load every existing booking in the calendar window for those dates and expand THOSE
    // to their own occupied windows, and check for any overlap.
    const newDurationMin = (() => {
      if (resolvedLessonTypeId == null) return SLOT_MIN;
      const lt = storage.getLessonTypeById(tenantId, resolvedLessonTypeId);
      return lt?.durationMin ?? SLOT_MIN;
    })();
    const newOccupied = new Set<string>();
    const isoFromMs = (ms: number) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    for (const s of slots) {
      const startMs = new Date(s + ":00").getTime();
      const n = Math.max(1, Math.ceil(newDurationMin / SLOT_MIN));
      for (let i = 0; i < n; i++) newOccupied.add(isoFromMs(startMs + i * SLOT_MIN * 60_000));
    }
    // Pull every booking on any affected date and expand their occupied windows.
    // Capacity-aware collision: for SAME-TYPE GROUP bookings, the slot is only
    // taken if cumulative occupants + new participants would exceed capacity.
    // For solo lessons or any other lesson type holding the slot, ANY overlap
    // blocks the booking.
    const affectedDates = Array.from(new Set(slots.map(s => isoDate(s))));
    const rangeStart = affectedDates.reduce((a, b) => a < b ? a : b);
    const rangeEnd = affectedDates.reduce((a, b) => a > b ? a : b);
    const existingBookings = storage.getBookingsInRange(tenantId, rangeStart + "T00:00", rangeEnd + "T23:59");
    const lessonTypeDurationsCheck = new Map<number, number>();
    for (const lt of storage.listLessonTypes(tenantId)) lessonTypeDurationsCheck.set(lt.id, lt.durationMin);
    // Per-slot tally of same-type group occupants already present.
    const sameTypeOccupantsAt = new Map<string, number>();
    const blockedByOther = new Set<string>();
    for (const b of existingBookings) {
      const bDur = b.lessonTypeId != null ? (lessonTypeDurationsCheck.get(b.lessonTypeId) ?? SLOT_MIN) : SLOT_MIN;
      const bStartMs = new Date(b.start + ":00").getTime();
      const bN = Math.max(1, Math.ceil(bDur / SLOT_MIN));
      const bPtCount = countParticipantsOnBooking(tenantId, b);
      for (let i = 0; i < bN; i++) {
        const slot = isoFromMs(bStartMs + i * SLOT_MIN * 60_000);
        if (!newOccupied.has(slot)) continue;
        // Same-type group booking: pool occupants for capacity check.
        if (
          resolvedLessonTypeId != null &&
          resolvedIsGroup &&
          b.lessonTypeId === resolvedLessonTypeId
        ) {
          sameTypeOccupantsAt.set(slot, (sameTypeOccupantsAt.get(slot) ?? 0) + bPtCount);
        } else {
          // Different lesson type, solo lesson, or untyped booking → hard block.
          blockedByOther.add(slot);
        }
      }
    }
    const conflicts: string[] = [];
    for (const slot of Array.from(newOccupied)) {
      if (blockedByOther.has(slot)) {
        conflicts.push(slot);
        continue;
      }
      const occ = sameTypeOccupantsAt.get(slot) ?? 0;
      if (occ + totalParticipants > lessonCapacity) {
        conflicts.push(slot);
      }
    }
    if (conflicts.length) {
      // Pick a user-friendly error: if any slot was filled by a same-type group
      // hitting capacity, message accordingly; otherwise generic taken message.
      const capacityConflict = conflicts.some(s => !blockedByOther.has(s));
      return res.status(409).json({
        error: capacityConflict
          ? `Not enough spots left in this group lesson. Please pick another time.`
          : "Some times were just taken. Please refresh and choose again.",
        takenSlots: conflicts,
      });
    }
    const bookingGroup = randomUUID();
    // Multi-kid: build a profile id for each kid in the kids[] array.
    // kids[0] always maps to the primary profile. kids[1+] get fresh
    // synthetic-phone profile rows so bookings carry the right playerName
    // without colliding on the (tenant_id, phone) unique index.
    const primaryPhoneNormalized = normalizePhone(phone);
    const kidProfileIds: number[] = [profile.id];
    if (kids.length > 1) {
      for (let i = 1; i < kids.length; i++) {
        const k = kids[i];
        // Skip if the kid name is the same as the primary (case-insensitive).
        if (k.playerName.trim().toLowerCase() === profile.playerName.trim().toLowerCase()) {
          kidProfileIds.push(profile.id);
          continue;
        }
        const syntheticPhone = `${primaryPhoneNormalized}-k${randomUUID().slice(0, 8)}`;
        const inserted = sqlite.prepare(
          `INSERT INTO profiles (tenant_id, phone, email, parent_name, player_name, notes, photo_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, '', ?)`,
        ).run(tenantId, syntheticPhone, email, parentName, k.playerName, k.notes || "", Date.now());
        kidProfileIds.push(Number(inserted.lastInsertRowid));
      }
    }
    const rows = storage.createBookings(tenantId, slotsAssigned.map(s => ({
      start: s.start,
      profileId: kidProfileIds[s.kidIndex] ?? profile.id,
      bookingGroup,
      createdAt: Date.now(),
      lessonTypeId: resolvedLessonTypeId,
    })), bookingAdminUserId);
    // Build participant profile id list: primary booker first, then each extra.
    // Strategy:
    //  - Extra with their own unique phone -> upsertProfile (normal merge).
    //  - Extra without a phone (parent booking 2+ of their own kids) -> insert
    //    a fresh profile row directly so we don't collide on phone uniqueness.
    const participantProfileIds: number[] = [profile.id];
    for (const p of participants) {
      const explicitPhone = normalizePhone(p.phone);
      if (explicitPhone && explicitPhone !== primaryPhoneNormalized) {
        const pProfile = storage.upsertProfile(tenantId, {
          phone: explicitPhone,
          email: p.email || email,
          parentName: p.parentName,
          playerName: p.playerName,
          notes: p.notes || "",
        });
        participantProfileIds.push(pProfile.id);
      } else {
        // Sibling: insert a fresh profile row that won't collide with the
        // primary booker on the (tenant_id, phone) unique index. Use a
        // synthetic key that includes primary phone + random suffix; this
        // is non-digit so phone lookups against real phones still miss it.
        const syntheticPhone = `${primaryPhoneNormalized}-p${randomUUID().slice(0, 8)}`;
        const inserted = sqlite.prepare(
          `INSERT INTO profiles (tenant_id, phone, email, parent_name, player_name, notes, photo_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, '', ?)`,
        ).run(tenantId, syntheticPhone, p.email || email, p.parentName, p.playerName, p.notes || "", Date.now());
        participantProfileIds.push(Number(inserted.lastInsertRowid));
      }
    }
    storage.addBookingParticipants(tenantId, bookingGroup, participantProfileIds);
    for (const r of rows) {
      // Reminder always goes to the primary parent contact (phone/email),
      // but the kid name in the reminder body should reflect which kid the
      // session is for. Look up the kid via the booking's profile id.
      const bookingProfile = storage.getProfileById(tenantId, r.profileId);
      const kidName = bookingProfile?.playerName || profile.playerName;
      scheduleRemindersForBooking(r.id, r.start, profile.phone, kidName, profile.email);
    }
    const expanded = rows.map(r => storage.expandBooking(tenantId, r));
    const ics = icsForBookings(expanded);
    const coachName = getSetting("coachName") || "Coach Skinner";
    const manageUrl = (process.env.PUBLIC_SITE_URL || getSetting("publicSiteUrl") || "").replace(/\/$/, "") + "/#/my-appointments";

    // Group expanded sessions by player name for kid-grouped emails.
    // For single-kid bookings this collapses to one group identical to today's UX.
    const sessionsByKid = new Map<string, typeof expanded>();
    for (const b of expanded.slice().sort((a, b) => a.start.localeCompare(b.start))) {
      const k = b.playerName || profile.playerName;
      const list = sessionsByKid.get(k) || [];
      list.push(b);
      sessionsByKid.set(k, list);
    }
    const kidNamesInBooking = Array.from(sessionsByKid.keys());
    const isMultiKid = kidNamesInBooking.length > 1;

    // Coach notification email (fire-and-forget)
    const recipients = getBookingEmailRecipients(tenantId, bookingAdminUserId);
    if (recipients.length > 0) {
      const summary = expanded.map(b => `• ${b.start.replace("T", " ")}`).join("\n");
      // Collect extra participants from the first booking (group bookings share participants across sessions)
      const extras = (expanded[0]?.extraParticipants || []).map(p => `${p.playerName}${p.parentName && p.parentName !== profile.parentName ? ` (parent: ${p.parentName})` : ""}`);
      const allPlayers = isMultiKid ? kidNamesInBooking : [profile.playerName, ...extras];
      const groupSize = allPlayers.length;
      const playerListText = groupSize > 1
        ? `Players (${groupSize}):\n${allPlayers.map(n => `  - ${n}`).join("\n")}`
        : `Player: ${profile.playerName}`;
      const playerListHtml = groupSize > 1
        ? `<li><b>Players (${groupSize}):</b><ul>${allPlayers.map(n => `<li>${n}</li>`).join("")}</ul></li>`
        : `<li><b>Player:</b> ${profile.playerName}</li>`;
      // Per-kid session breakdown (only when multi-kid; otherwise reuse flat summary)
      const kidBreakdownText = isMultiKid
        ? "\n\nSessions by player:\n" + kidNamesInBooking.map(k =>
            `\n${k}:\n` + (sessionsByKid.get(k) || []).map(b => `  • ${b.start.replace("T", " ")}`).join("\n"),
          ).join("")
        : "";
      const kidBreakdownHtml = isMultiKid
        ? "<p><b>Sessions by player:</b></p>" + kidNamesInBooking.map(k =>
            `<p style="margin:8px 0 4px 0;"><b>${k}</b></p><ul>${(sessionsByKid.get(k) || []).map(b => `<li>${b.start.replace("T", " ")}</li>`).join("")}</ul>`,
          ).join("")
        : `<p><b>Sessions:</b></p><pre>${summary}</pre>`;
      const subjectSuffix = isMultiKid ? ` +${kidNamesInBooking.length - 1} kid${kidNamesInBooking.length - 1 === 1 ? "" : "s"}` : (groupSize > 1 ? ` +${groupSize - 1} others` : "");
      for (const recipient of recipients) {
        sendBookingEmail({
          to: recipient,
          subject: `New booking: ${kidNamesInBooking[0]}${subjectSuffix} (${expanded.length} session${expanded.length === 1 ? "" : "s"})`,
          text: `New softball lesson booking.\n\n${playerListText}\nBooking parent: ${profile.parentName}\nPhone: ${profile.phone}\nEmail: ${profile.email}\nNotes: ${profile.notes || "(none)"}${isMultiKid ? kidBreakdownText : `\n\nSessions:\n${summary}`}\n\nThe attached .ics file will add these to your Apple Calendar.`,
          html: `<p>New softball lesson booking.</p><ul>${playerListHtml}<li><b>Booking parent:</b> ${profile.parentName}</li><li><b>Phone:</b> ${profile.phone}</li><li><b>Email:</b> ${profile.email}</li><li><b>Notes:</b> ${profile.notes || "(none)"}</li></ul>${kidBreakdownHtml}<p>The attached .ics file will add these to your Apple Calendar.</p>`,
          icsContent: ics,
          icsFilename: `booking-${bookingGroup.slice(0, 8)}.ics`,
        }).catch(e => console.error("coach email send error:", e));
      }
    }

    // Parent confirmation — channel decided by setting
    const channel = (getSetting("reminderChannel") || "email").toLowerCase();
    const sessionLines = expanded
      .slice()
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(b => `• ${isMultiKid ? `[${b.playerName}] ` : ""}${formatDateLong(isoDate(b.start))} — ${formatTime(b.start.split("T")[1])}`)
      .join("\n");
    // For HTML emails, when multi-kid, group sessions under each kid heading.
    // Single-kid renders the original flat list.
    const sessionLinesHtml = isMultiKid
      ? kidNamesInBooking.map(k =>
          `<p style="font-size:16px;margin:12px 0 4px 0;font-weight:600;color:#1f5a37;">${k}</p>` +
          `<ul style="font-size:16px;line-height:1.7;margin:0 0 8px 18px;padding:0;">${(sessionsByKid.get(k) || []).map(b => `<li>${formatDateLong(isoDate(b.start))} — ${formatTime(b.start.split("T")[1])}</li>`).join("")}</ul>`,
        ).join("")
      : expanded
          .slice()
          .sort((a, b) => a.start.localeCompare(b.start))
          .map(b => `<li>${formatDateLong(isoDate(b.start))} — ${formatTime(b.start.split("T")[1])}</li>`)
          .join("");
    const headlineHtml = isMultiKid
      ? `<p style="font-size:16px;margin:0 0 8px 0;">You're booked! Here are your confirmed sessions for <b>${kidNamesInBooking.length}</b> players:</p>`
      : `<p style="font-size:16px;margin:0 0 8px 0;">You're booked! Here are <b>${profile.playerName}</b>'s confirmed sessions:</p>`;
    const sessionListWrapped = isMultiKid
      ? sessionLinesHtml
      : `<ul style="font-size:16px;line-height:1.7;margin:8px 0 16px 18px;padding:0;">${sessionLinesHtml}</ul>`;

    if ((channel === "email" || channel === "both") && profile.email) {
      const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f1a14;">
        <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
          <div style="background:#ffffff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
            <div style="font-size:20px;font-weight:600;margin-bottom:12px;color:#1f5a37;">${coachName} · Softball Lessons</div>
            ${headlineHtml}
            ${sessionListWrapped}
            <p style="font-size:14px;color:#525f57;margin:0 0 16px 0;">A calendar file (.ics) is attached — open it on your phone or laptop to add these to your calendar.</p>
            <div style="text-align:center;margin:28px 0;">
              <a href="${manageUrl}" style="display:inline-block;background:#1f5a37;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:16px;">Manage your appointments</a>
            </div>
            <div style="background:#f0f6f2;border-left:4px solid #1f5a37;padding:12px 16px;border-radius:6px;margin:16px 0;">
              <div style="font-weight:600;font-size:14px;margin-bottom:4px;">Need to change or cancel?</div>
              <div style="font-size:14px;line-height:1.5;color:#3a4540;">You can do it yourself anytime up to <b>24 hours before</b> the session. Just open the link above and use the email you booked with (${profile.email || "your booking email"}). Save this email — the link works any time.</div>
            </div>
            ${(req.tenant?.payment_note || "").trim() ? `<div style="background:#eef7f1;border-left:4px solid #1f5a37;padding:12px 16px;border-radius:6px;margin:12px 0;">
              <div style="font-weight:600;font-size:14px;margin-bottom:4px;">Payment</div>
              <div style="font-size:14px;line-height:1.5;color:#3a4540;">${req.tenant!.payment_note!.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
            </div>` : ""}
            <div style="background:#fff4e8;border-left:4px solid #d18e1c;padding:12px 16px;border-radius:6px;margin:12px 0;">
              <div style="font-weight:600;font-size:14px;margin-bottom:4px;">Cancellation policy</div>
              <div style="font-size:14px;line-height:1.5;color:#3a4540;">Cancellations or no-shows within <b>24 hours</b> of the scheduled session are subject to a <b>$30 fee per 30-minute session</b>, billed at the next lesson. We appreciate your understanding—late cancellations prevent us from offering the time to other families.</div>
            </div>
            <p style="font-size:13px;color:#7a857e;margin:16px 0 0 0;">Within 24 hours? Text ${coachName} directly.</p>
          </div>
        </div></body></html>`;
      const paymentNoteForText = (req.tenant?.payment_note || "").trim();
      const headlineText = isMultiKid
        ? `${coachName} — your lessons are confirmed for ${kidNamesInBooking.join(", ")}:`
        : `${coachName} — ${profile.playerName}'s lesson${expanded.length === 1 ? "" : "s"} confirmed:`;
      const text = `${headlineText}\n${sessionLines}\n\nA calendar file (.ics) is attached for your records.\n\nManage your appointments: ${manageUrl}\nTo change or cancel, please use the link above (sign in with the email you booked with: ${profile.email || "your booking email"}). Changes are accepted up to 24 hours before the scheduled session.${paymentNoteForText ? `\n\nPayment: ${paymentNoteForText}` : ""}\n\nCancellation policy: Cancellations or no-shows within 24 hours of the scheduled session are subject to a $30 fee per 30-minute session, billed at the next lesson.`;
      sendEmail({
        to: profile.email,
        subject: isMultiKid
          ? `Booking confirmed: ${kidNamesInBooking.join(" & ")} — ${expanded.length} session${expanded.length === 1 ? "" : "s"}`
          : `Booking confirmed: ${profile.playerName} — ${expanded.length} session${expanded.length === 1 ? "" : "s"}`,
        html, text,
        attachments: [{ filename: `lessons-${bookingGroup.slice(0, 8)}.ics`, content: ics }],
      }).catch(e => console.error("parent email send error:", e));
    }
    if ((channel === "sms" || channel === "both") && profile.phone) {
      const smsHeadline = isMultiKid
        ? `${coachName}: lessons confirmed for ${kidNamesInBooking.join(" & ")}.`
        : `${coachName}: ${profile.playerName}'s lesson${expanded.length === 1 ? "" : "s"} confirmed.`;
      const smsBody = `${smsHeadline}\n${sessionLines}\nManage: ${manageUrl}\n\nCancellations within 24 hrs are subject to a $30/session fee. Reply STOP to opt out.`;
      sendSms(profile.phone, smsBody).catch(e => console.error("sms confirmation error:", e));
    }

    res.json({
      ok: true, bookingGroup, bookings: expanded, ics,
      coach: { name: coachName, textPhone: getSetting("coachPhone") },
      manageUrl,
    });
  });

  // List bookings (admin)
  app.get("/api/bookings", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const rows = storage.getBookings(tenantId).map(b => storage.expandBooking(tenantId, b));
    res.json({ bookings: rows });
  });

  // List bookings for a profile (self-service lookup by phone)
  app.get("/api/my-bookings/:phone", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const profile = storage.getProfileByPhone(tenantId, req.params.phone);
    if (!profile) return res.json({ profile: null, bookings: [] });
    const rows = storage.getBookingsForProfile(tenantId, profile.id).map(b => storage.expandBooking(tenantId, b));
    rows.sort((a, b) => a.start.localeCompare(b.start));
    res.json({ profile, bookings: rows });
  });

  // List bookings for a profile (self-service lookup by EMAIL)
  app.get("/api/my-bookings-by-email/:email", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const profile = storage.getProfileByEmail(tenantId, decodeURIComponent(req.params.email));
    if (!profile) return res.json({ profile: null, bookings: [] });
    const rows = storage.getBookingsForProfile(tenantId, profile.id).map(b => storage.expandBooking(tenantId, b));
    rows.sort((a, b) => a.start.localeCompare(b.start));
    res.json({ profile, bookings: rows });
  });

  // Self-service profile update — requires matching email or phone (acts as proof of ownership)
  // Save the list of kids on a profile without booking. Lets returning users
  // add siblings to their account from the profile step and have them remembered
  // even if they don't finish a checkout. Ownership is proven via email or phone
  // matching the existing profile, same as PATCH /api/profile/:id.
  app.post("/api/profile/:id/kids", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const id = Number(req.params.id);
    const existing = storage.getProfileById(tenantId, id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    const isAdmin = !!(req as any).session?.admin;
    if (!isAdmin) {
      const proofEmail = String(req.body?.proofEmail || "").trim().toLowerCase();
      const proofPhone = normalizePhone(String(req.body?.proofPhone || ""));
      const emailMatch = !!proofEmail && (existing.email || "").trim().toLowerCase() === proofEmail;
      const phoneMatch = !!proofPhone && existing.phone === proofPhone;
      if (!emailMatch && !phoneMatch) {
        return res.status(403).json({ error: "Verification failed. Please match the email or phone on file." });
      }
    }
    const rawNames = Array.isArray(req.body?.kidNames) ? req.body.kidNames : [];
    const kidNames: string[] = rawNames
      .filter((n: unknown) => typeof n === "string" && n.trim().length > 0)
      .map((n: string) => n.trim());
    const updated = storage.mergeKidsOnProfile(tenantId, id, kidNames);
    res.json(updated || existing);
  });

  app.patch("/api/profile/:id", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const id = Number(req.params.id);
    const existing = storage.getProfileById(tenantId, id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    const isAdmin = !!(req as any).session?.admin;
    if (!isAdmin) {
      // Customer must prove ownership by matching CURRENT email or CURRENT phone
      const proofEmail = String(req.body?.proofEmail || "").trim().toLowerCase();
      const proofPhone = normalizePhone(String(req.body?.proofPhone || ""));
      const emailMatch = !!proofEmail && (existing.email || "").trim().toLowerCase() === proofEmail;
      const phoneMatch = !!proofPhone && existing.phone === proofPhone;
      if (!emailMatch && !phoneMatch) {
        return res.status(403).json({ error: "Verification failed. Please match the email or phone on file." });
      }
    }
    const patch: any = {};
    if (typeof req.body?.email === "string") patch.email = req.body.email.trim();
    if (typeof req.body?.parentName === "string" && req.body.parentName.trim()) patch.parentName = req.body.parentName.trim();
    if (typeof req.body?.playerName === "string" && req.body.playerName.trim()) patch.playerName = req.body.playerName.trim();
    if (typeof req.body?.phone === "string") patch.phone = req.body.phone;
    if (typeof req.body?.notes === "string") patch.notes = req.body.notes;
    // If changing phone, ensure no conflict with another profile
    if (patch.phone) {
      const collides = storage.getProfileByPhone(tenantId, patch.phone);
      if (collides && collides.id !== id) {
        return res.status(409).json({ error: "That phone number is already used by another account." });
      }
    }
    const updated = storage.updateProfile(tenantId, id, patch);
    res.json(updated);
  });

  // Cancel single booking (customer or admin)
  app.delete("/api/bookings/:id", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const id = Number(req.params.id);
    const isAdmin = String(req.query.admin || "") === "1";
    const b = storage.getBookingById(tenantId, id);
    if (!b) return res.status(404).json({ error: "Not found" });
    {
      const leadHrs = tenantMinLeadHours(req);
      const leadMs = tenantMinLeadMs(req);
      if (!isAdmin && isInsideLeadWindow(b.start, leadMs)) {
        return res.status(400).json({ error: leadHrs === 0
          ? "This booking is in the past."
          : `Within ${leadHrs} hour${leadHrs === 1 ? "" : "s"} — please contact the coach to cancel.` });
      }
    }
    // Capture profile/details before delete so we can email
    const profile = storage.getProfileById(tenantId, b.profileId);
    cancelRemindersForBooking(id);
    storage.deleteBooking(tenantId, id);

    // Fire-and-forget notifications
    const coachName = getSetting("coachName") || "Coach Skinner";
    const manageUrl = (process.env.PUBLIC_SITE_URL || getSetting("publicSiteUrl") || "").replace(/\/$/, "") + "/#/my-appointments";
    const dateLong = formatDateLong(isoDate(b.start));
    const timeStr = formatTime(b.start.split("T")[1]);
    const whoCancelled = isAdmin ? coachName : (profile?.parentName || "The parent");

    const cancelRecipients = getBookingEmailRecipients(tenantId, b.adminUserId ?? undefined);
    if (cancelRecipients.length > 0 && !isAdmin && profile) {
      for (const recipient of cancelRecipients) {
        sendEmail({
          to: recipient,
          subject: `Booking CANCELLED: ${profile.playerName} — ${dateLong} ${timeStr}`,
          text: `${profile.parentName} cancelled a lesson.\n\nPlayer: ${profile.playerName}\nParent: ${profile.parentName}\nPhone: ${profile.phone}\nEmail: ${profile.email}\n\nWas scheduled: ${dateLong} at ${timeStr}\n\nThe slot is now open again.`,
          html: `<p><b>${profile.parentName}</b> cancelled a lesson.</p><ul><li><b>Player:</b> ${profile.playerName}</li><li><b>Parent:</b> ${profile.parentName}</li><li><b>Phone:</b> ${profile.phone}</li><li><b>Email:</b> ${profile.email}</li></ul><p><b>Was scheduled:</b> ${dateLong} at ${timeStr}</p><p>The slot is now open again.</p>`,
        }).catch(e => console.error("coach cancel email error:", e));
      }
    }

    if (profile && profile.email) {
      sendEmail({
        to: profile.email,
        subject: `Cancelled: ${profile.playerName}'s lesson — ${dateLong}`,
        text: `${coachName} — your lesson has been cancelled.\n\nPlayer: ${profile.playerName}\nWas scheduled: ${dateLong} at ${timeStr}\nCancelled by: ${whoCancelled}\n\nWant to rebook? ${manageUrl}`,
        html: `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f1a14;"><div style="max-width:560px;margin:0 auto;padding:24px 16px;"><div style="background:#ffffff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.06);"><div style="font-size:20px;font-weight:600;margin-bottom:12px;color:#1f5a37;">${coachName} · Softball Lessons</div><p style="font-size:16px;margin:0 0 12px 0;">This is a confirmation that <b>${profile.playerName}'s</b> lesson has been cancelled.</p><div style="background:#fff4f4;border-left:4px solid #c0392b;padding:12px 16px;border-radius:6px;margin:12px 0;"><div style="font-weight:600;font-size:14px;margin-bottom:4px;">Cancelled session</div><div style="font-size:15px;line-height:1.5;">${dateLong} at ${timeStr}</div><div style="font-size:13px;color:#7a857e;margin-top:6px;">Cancelled by ${whoCancelled}</div></div><div style="text-align:center;margin:24px 0;"><a href="${manageUrl}" style="display:inline-block;background:#1f5a37;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:16px;">Book another session</a></div></div></div></body></html>`,
      }).catch(e => console.error("parent cancel email error:", e));
    }

    // Notify waitlist (Phase 2): when a booking that holds a group slot is
    // cancelled, email everyone on the waitlist for the exact (start,
    // lessonTypeId) pair. They race to claim. We mark them notified so we
    // don't re-spam them if they ignore the email and the next booking is
    // cancelled too. The coach can manually clear stale waitlist entries.
    if (b.lessonTypeId != null) {
      try {
        const waiters = sqlite.prepare(
          `SELECT id, parent_name, player_name, email, phone
             FROM waitlist
            WHERE tenant_id = ? AND start = ? AND lesson_type_id = ?
              AND notified_at IS NULL`
        ).all(tenantId, b.start, b.lessonTypeId) as Array<{
          id: number; parent_name: string; player_name: string; email: string; phone: string;
        }>;
        if (waiters.length) {
          const lt = storage.getLessonTypeById(tenantId, b.lessonTypeId);
          const ltName = lt?.name || "group lesson";
          const bookingUrl = (process.env.PUBLIC_SITE_URL || getSetting("publicSiteUrl") || "").replace(/\/$/, "") +
            `/#/?prefillLessonType=${b.lessonTypeId}&prefillStart=${encodeURIComponent(b.start)}`;
          const now = Date.now();
          for (const w of waiters) {
            if (w.email) {
              sendEmail({
                to: w.email,
                subject: `A spot opened up: ${ltName} on ${dateLong} at ${timeStr}`,
                text: `Hi ${w.parent_name},\n\nA spot just opened up for the ${ltName} on ${dateLong} at ${timeStr}. First come, first served — grab it here:\n\n${bookingUrl}\n\nIf you no longer want this slot, you can ignore this email; we'll remove you from the waitlist automatically next time the slot fills again.\n\n— ${coachName}`,
                html: `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f1a14;"><div style="max-width:560px;margin:0 auto;padding:24px 16px;"><div style="background:#ffffff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.06);"><div style="font-size:20px;font-weight:600;margin-bottom:12px;color:#1f5a37;">${coachName} · Spot opened up</div><p style="font-size:16px;margin:0 0 12px 0;">Hi <b>${w.parent_name}</b>, a spot just opened for the <b>${ltName}</b>.</p><div style="background:#f0f8f4;border-left:4px solid #1f5a37;padding:12px 16px;border-radius:6px;margin:12px 0;"><div style="font-weight:600;font-size:14px;margin-bottom:4px;">When</div><div style="font-size:15px;line-height:1.5;">${dateLong} at ${timeStr}</div></div><p style="font-size:14px;margin:8px 0;">First come, first served — click below to claim your spot.</p><div style="text-align:center;margin:24px 0;"><a href="${bookingUrl}" style="display:inline-block;background:#1f5a37;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:16px;">Grab the spot</a></div></div></div></body></html>`,
              }).catch(e => console.error("waitlist notify email error:", e));
            }
            sqlite.prepare(`UPDATE waitlist SET notified_at = ? WHERE id = ?`).run(now, w.id);
          }
        }
      } catch (e) {
        console.error("waitlist notify failure:", e);
      }
    }

    res.json({ ok: true });
  });

  // ---- Waitlist (Phase 2) ---------------------------------------------
  // Customers join a waitlist when a group slot is full. They get emailed
  // when a spot frees up for the same (start, lessonTypeId). The list is
  // visible to admins for management.

  // POST /api/waitlist — add an entry
  app.post("/api/waitlist", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    if ((getSetting("waitlistEnabled") || "1") !== "1") {
      return res.status(400).json({ error: "Waitlist is not enabled for this site." });
    }
    const parsed = insertWaitlistSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const d = parsed.data;
    // Sanity: lesson type must exist and be a group lesson on this tenant.
    const lt = storage.getLessonTypeById(tenantId, d.lessonTypeId);
    if (!lt) return res.status(400).json({ error: "Invalid lesson type for this site." });
    if (((lt as any).isGroup ?? 0) !== 1) {
      return res.status(400).json({ error: "Waitlist is only available for group lessons." });
    }
    // De-dupe on (tenant, start, lessonType, phone) so a parent doesn't
    // accidentally sign up twice.
    const existing = sqlite.prepare(
      `SELECT id FROM waitlist WHERE tenant_id = ? AND start = ? AND lesson_type_id = ? AND phone = ?`
    ).get(tenantId, d.start, d.lessonTypeId, normalizePhone(d.phone)) as { id: number } | undefined;
    if (existing) {
      return res.status(200).json({ ok: true, id: existing.id, dedup: true });
    }
    const info = sqlite.prepare(
      `INSERT INTO waitlist
         (tenant_id, start, lesson_type_id, parent_name, player_name, phone, email, notes, participants_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tenantId, d.start, d.lessonTypeId,
      d.parentName, d.playerName, normalizePhone(d.phone),
      d.email, d.notes, d.participantsCount, Date.now(),
    );
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });

  // DELETE /api/waitlist/:id — remove (customer or admin)
  app.delete("/api/waitlist/:id", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const info = sqlite.prepare(
      `DELETE FROM waitlist WHERE id = ? AND tenant_id = ?`
    ).run(id, tenantId);
    if (info.changes === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  });

  // GET /api/waitlist?start=&lessonTypeId= — admins see full list, customers
  // can check their own entry by phone via ?phone=
  app.get("/api/waitlist", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const isAdmin = isAdminReq(req);
    const phone = req.query.phone ? normalizePhone(String(req.query.phone)) : "";
    const start = req.query.start ? String(req.query.start) : "";
    const ltId = req.query.lessonTypeId ? Number(req.query.lessonTypeId) : null;
    if (!isAdmin && !phone) {
      return res.status(400).json({ error: "phone required for customer lookup" });
    }
    let sql = `SELECT id, tenant_id AS tenantId, start, lesson_type_id AS lessonTypeId,
                      parent_name AS parentName, player_name AS playerName,
                      phone, email, notes, participants_count AS participantsCount,
                      notified_at AS notifiedAt, created_at AS createdAt
                 FROM waitlist
                WHERE tenant_id = ?`;
    const params: (string | number)[] = [tenantId];
    if (phone) { sql += ` AND phone = ?`; params.push(phone); }
    if (start) { sql += ` AND start = ?`; params.push(start); }
    if (ltId != null && Number.isFinite(ltId)) { sql += ` AND lesson_type_id = ?`; params.push(ltId); }
    sql += ` ORDER BY start ASC, created_at ASC`;
    const rows = sqlite.prepare(sql).all(...params);
    res.json({ entries: rows });
  });

  // Reschedule single booking
  app.patch("/api/bookings/:id", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const id = Number(req.params.id);
    const newStart = String(req.body?.newStart || "");
    const isAdmin = String(req.query.admin || "") === "1";
    const b = storage.getBookingById(tenantId, id);
    if (!b) return res.status(404).json({ error: "Not found" });
    const _leadHrs = tenantMinLeadHours(req);
    const _leadMs = tenantMinLeadMs(req);
    const _maxDays = tenantMaxBookingDays(req);
    const _maxMs = tenantMaxBookingWindowMs(req);
    if (!isAdmin && isInsideLeadWindow(b.start, _leadMs)) {
      return res.status(400).json({ error: _leadHrs === 0
        ? "This booking has already started."
        : `Within ${_leadHrs} hour${_leadHrs === 1 ? "" : "s"} — please contact the coach to reschedule.` });
    }
    if (!isAdmin && isInsideLeadWindow(newStart, _leadMs)) {
      return res.status(400).json({ error: _leadHrs === 0
        ? "New time must be in the future."
        : `New time must be at least ${_leadHrs} hour${_leadHrs === 1 ? "" : "s"} from now.` });
    }
    if (!isAdmin && isBeyondMaxWindow(newStart, _maxMs)) {
      return res.status(400).json({ error: `New time must be within ${_maxDays} days.` });
    }
    // collision
    const existing = storage.getBookingsByStarts(tenantId, [newStart]).filter(x => x.id !== id);
    if (existing.length) return res.status(409).json({ error: "That time is already booked." });
    // ensure newStart is a valid available slot — and that the lesson's full
    // duration fits inside the open window at the new start time.
    const rescheduleDur = b.lessonTypeId != null
      ? (storage.getLessonTypeById(tenantId, b.lessonTypeId)?.durationMin ?? SLOT_MIN)
      : SLOT_MIN;
    const validSlots = new Set(
      slotsForDate(tenantId, isoDate(newStart), null, b.adminUserId ?? undefined, rescheduleDur)
    );
    if (!validSlots.has(newStart)) return res.status(400).json({ error: "Not an open time slot." });
    const oldStart = b.start;
    storage.updateBookingStart(tenantId, id, newStart);
    const profile = storage.getProfileById(tenantId, b.profileId);
    if (profile) rescheduleRemindersForBooking(id, newStart, profile.phone, profile.playerName, profile.email);

    // Fire-and-forget notifications
    const coachName = getSetting("coachName") || "Coach Skinner";
    const manageUrl = (process.env.PUBLIC_SITE_URL || getSetting("publicSiteUrl") || "").replace(/\/$/, "") + "/#/my-appointments";
    const oldDateLong = formatDateLong(isoDate(oldStart));
    const oldTime = formatTime(oldStart.split("T")[1]);
    const newDateLong = formatDateLong(isoDate(newStart));
    const newTime = formatTime(newStart.split("T")[1]);
    const whoChanged = isAdmin ? coachName : (profile?.parentName || "The parent");

    const rescheduleRecipients = getBookingEmailRecipients(tenantId, b.adminUserId ?? undefined);
    if (rescheduleRecipients.length > 0 && !isAdmin && profile) {
      for (const recipient of rescheduleRecipients) {
        sendEmail({
          to: recipient,
          subject: `Booking RESCHEDULED: ${profile.playerName} — now ${newDateLong} ${newTime}`,
          text: `${profile.parentName} rescheduled a lesson.\n\nPlayer: ${profile.playerName}\nParent: ${profile.parentName}\nPhone: ${profile.phone}\nEmail: ${profile.email}\n\nOld: ${oldDateLong} at ${oldTime}\nNew: ${newDateLong} at ${newTime}`,
          html: `<p><b>${profile.parentName}</b> rescheduled a lesson.</p><ul><li><b>Player:</b> ${profile.playerName}</li><li><b>Parent:</b> ${profile.parentName}</li><li><b>Phone:</b> ${profile.phone}</li><li><b>Email:</b> ${profile.email}</li></ul><p><b>Old:</b> ${oldDateLong} at ${oldTime}<br><b>New:</b> ${newDateLong} at ${newTime}</p>`,
        }).catch(e => console.error("coach reschedule email error:", e));
      }
    }

    if (profile && profile.email) {
      sendEmail({
        to: profile.email,
        subject: `Rescheduled: ${profile.playerName}'s lesson — now ${newDateLong}`,
        text: `${coachName} — your lesson has been rescheduled.\n\nPlayer: ${profile.playerName}\nOld: ${oldDateLong} at ${oldTime}\nNew: ${newDateLong} at ${newTime}\nRescheduled by: ${whoChanged}\n\nManage your appointments: ${manageUrl}`,
        html: `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f1a14;"><div style="max-width:560px;margin:0 auto;padding:24px 16px;"><div style="background:#ffffff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.06);"><div style="font-size:20px;font-weight:600;margin-bottom:12px;color:#1f5a37;">${coachName} · Softball Lessons</div><p style="font-size:16px;margin:0 0 12px 0;"><b>${profile.playerName}'s</b> lesson has been rescheduled.</p><div style="background:#fff8ec;border-left:4px solid #d18e1c;padding:12px 16px;border-radius:6px;margin:12px 0;"><div style="font-size:13px;color:#7a857e;text-decoration:line-through;">${oldDateLong} at ${oldTime}</div><div style="font-weight:600;font-size:15px;margin-top:6px;color:#1f5a37;">→ ${newDateLong} at ${newTime}</div><div style="font-size:13px;color:#7a857e;margin-top:6px;">Changed by ${whoChanged}</div></div><div style="text-align:center;margin:24px 0;"><a href="${manageUrl}" style="display:inline-block;background:#1f5a37;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:16px;">Manage your appointments</a></div></div></div></body></html>`,
      }).catch(e => console.error("parent reschedule email error:", e));
    }

    res.json({ ok: true });
  });

  // List recent reminders (admin diagnostic)
  app.get("/api/reminders", requireAdmin, (_req, res) => {
    res.json({ reminders: listReminders({ limit: 200 }) });
  });

  // Public coach contact info (used by the booking confirmation 'Text Coach' button)
  app.get("/api/coach", (req, res) => {
    const tenantId = requireTenantId(req, res);
    if (tenantId === null) return;
    const t = getTenantById(sqlite, tenantId);
    if (!t) return res.status(404).json({ error: "Tenant not found" });
    res.json({
      name: t.name || getSetting("coachName"),
      textPhone: t.contact_phone || getSetting("coachPhone"),
      email: t.contact_email || getSetting("coachEmail"),
    });
  });

  // Settings (admin)
  // --- Tenant branding (per-tenant settings) ---
  // GET returns the current tenant's full branding row.
  app.get("/api/admin/branding", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res);
    if (tenantId === null) return;
    const t = getTenantById(sqlite, tenantId);
    if (!t) return res.status(404).json({ error: "Tenant not found" });
    res.json({
      id: t.id,
      slug: t.slug,
      name: t.name,
      sport: t.sport,
      primaryColor: t.primary_color,
      logoPath: t.logo_path,
      heroPath: t.hero_path,
      heroFocalX: t.hero_focal_x ?? 50,
      heroFocalY: t.hero_focal_y ?? 50,
      heroZoom: t.hero_zoom ?? 100,
      tagline: t.tagline,
      about: t.about,
      contactPhone: t.contact_phone,
      contactEmail: t.contact_email,
      paymentNote: t.payment_note ?? "",
      maxBookingDays: t.max_booking_days ?? 30,
      minLeadHours: t.min_lead_hours ?? 24,
      contactLocation: t.contact_location,
      bookerLabel: t.booker_label,
      attendeeLabel: t.attendee_label,
      plan: t.plan,
      trialEndsAt: t.trial_ends_at,
    });
  });
  // PATCH updates the current tenant's branding.  Only whitelisted fields are
  // accepted so a malicious client can't set tenant_id, slug, plan, etc.
  app.patch("/api/admin/branding", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res);
    if (tenantId === null) return;
    const body = req.body || {};
    const fieldMap: Record<string, string> = {
      name: "name",
      sport: "sport",
      primaryColor: "primary_color",
      logoPath: "logo_path",
      heroPath: "hero_path",
      tagline: "tagline",
      about: "about",
      contactPhone: "contact_phone",
      contactEmail: "contact_email",
      contactLocation: "contact_location",
      bookerLabel: "booker_label",
      attendeeLabel: "attendee_label",
      paymentNote: "payment_note",
    };
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
      if (typeof body[bodyKey] === "string") {
        sets.push(`${dbCol} = ?`);
        vals.push(body[bodyKey]);
      }
    }
    // Hero positioning: clamp to safe ranges so a bad client can't write
    // garbage. focal coords are 0-100 (percent). zoom is 100-300 (1x-3x).
    const numFields: Record<string, { col: string; min: number; max: number }> = {
      heroFocalX: { col: "hero_focal_x", min: 0, max: 100 },
      heroFocalY: { col: "hero_focal_y", min: 0, max: 100 },
      heroZoom:   { col: "hero_zoom",    min: 100, max: 300 },
      // Booking window controls (per-tenant). Caps prevent abuse:
      //   max_booking_days: 1…365 (1 day to 1 year ahead)
      //   min_lead_hours: 0…168 (same-day to 1 week notice)
      maxBookingDays: { col: "max_booking_days", min: 1, max: 365 },
      minLeadHours:   { col: "min_lead_hours",   min: 0, max: 168 },
    };
    for (const [bodyKey, cfg] of Object.entries(numFields)) {
      const v = body[bodyKey];
      if (typeof v === "number" && Number.isFinite(v)) {
        const clamped = Math.max(cfg.min, Math.min(cfg.max, Math.round(v)));
        sets.push(`${cfg.col} = ?`);
        vals.push(clamped);
      }
    }
    if (sets.length === 0) return res.json({ ok: true, updated: 0 });
    vals.push(tenantId);
    sqlite.prepare(`UPDATE tenants SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    res.json({ ok: true, updated: sets.length });
  });
  // Logo upload — stores file in /uploads/branding and saves path to tenant.logo_path.
  app.post("/api/admin/branding/logo", requireAdmin, brandingUpload.single("logo"), (req, res) => {
    const tenantId = requireTenantId(req, res);
    if (tenantId === null) return;
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    const path = `/uploads/branding/${file.filename}`;
    sqlite.prepare(`UPDATE tenants SET logo_path = ? WHERE id = ?`).run(path, tenantId);
    res.json({ ok: true, path });
  });
  app.post("/api/admin/branding/hero", requireAdmin, brandingUpload.single("hero"), (req, res) => {
    const tenantId = requireTenantId(req, res);
    if (tenantId === null) return;
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    const path = `/uploads/branding/${file.filename}`;
    // Reset focal point + zoom on a new upload so a previously-tweaked crop
    // doesn't ruin a fresh photo. Coach can re-position from the editor.
    sqlite.prepare(
      `UPDATE tenants SET hero_path = ?, hero_focal_x = 50, hero_focal_y = 50, hero_zoom = 100 WHERE id = ?`
    ).run(path, tenantId);
    res.json({ ok: true, path });
  });
  // Serve branding assets (logos, hero images) — public so unauthenticated visitors can render them.
  app.use("/uploads/branding", express.static(BRANDING_DIR, {
    fallthrough: false,
    maxAge: "1h",
  }));

  app.get("/api/settings", requireAdmin, (_req, res) => {
    const s = getAllSettings();
    // mask secrets when returning
    const mask = (v: string) => v ? v.slice(0, 6) + "…" + v.slice(-3) : "";
    if (s.resendApiKey) s.resendApiKey = mask(s.resendApiKey);
    if (s.twilioAccountSid) s.twilioAccountSid = mask(s.twilioAccountSid);
    if (s.twilioAuthToken) s.twilioAuthToken = mask(s.twilioAuthToken);
    res.json(s);
  });
  app.put("/api/settings", requireAdmin, (req, res) => {
    const body = req.body || {};
    const allowed = [
      "coachName", "coachPhone", "coachEmail",
      "resendApiKey", "resendFromEmail",
      "twilioAccountSid", "twilioAuthToken", "twilioFromPhone",
      "reminderChannel", "publicSiteUrl",
    ];
    const updates: Record<string, string> = {};
    for (const k of allowed) {
      if (typeof body[k] === "string" && body[k].length > 0) updates[k] = body[k];
    }
    setSettings(updates);
    res.json({ ok: true });
  });
  app.post("/api/settings/test-sms", requireAdmin, async (_req, res) => {
    const to = getSetting("coachPhone");
    if (!to) return res.status(400).json({ error: "Set coach phone first" });
    const coachName = getSetting("coachName") || "Coach";
    const result = await sendSms(to, `Test from your booking app — ${coachName} SMS is working.`);
    res.json(result);
  });
  // ===== Photo uploads (profile pictures) =====
  // Serve uploaded photos publicly (read-only)
  app.use("/uploads/photos", express.static(PHOTO_DIR, {
    maxAge: "7d",
    setHeaders: (res) => { res.setHeader("Cache-Control", "public, max-age=604800"); },
  }));

  // Upload or replace a profile photo. Admin OR customer with matching proofEmail.
  app.post("/api/profile/:id/photo", photoUpload.single("photo"), async (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    try {
      const id = Number(req.params.id);
      const profile = storage.getProfileById(tenantId, id);
      if (!profile) return res.status(404).json({ error: "Profile not found" });
      if (!isAdminReq(req)) {
        const proof = String((req.body && req.body.proofEmail) || "");
        if (!matchesProofEmail(profile.email, proof)) {
          return res.status(403).json({ error: "Verification failed. Please match the email on file." });
        }
      }
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      // Resize to max 400x400 jpeg, save with random filename
      const filename = `${id}-${randomUUID()}.jpg`;
      const fullPath = path.join(PHOTO_DIR, filename);
      await sharp(req.file.buffer)
        .rotate() // honor EXIF orientation
        .resize(400, 400, { fit: "cover", position: "center" })
        .jpeg({ quality: 85 })
        .toFile(fullPath);

      // Delete old photo if present
      if (profile.photoPath) {
        const oldName = path.basename(profile.photoPath);
        const oldPath = path.join(PHOTO_DIR, oldName);
        try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch {}
      }

      const publicPath = `/uploads/photos/${filename}`;
      const updated = storage.updateProfile(tenantId, id, { photoPath: publicPath });
      res.json({ ok: true, photoPath: publicPath, profile: updated });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || "Upload failed" });
    }
  });

  // Delete a profile photo. Admin OR customer with matching proofEmail.
  app.delete("/api/profile/:id/photo", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const id = Number(req.params.id);
    const profile = storage.getProfileById(tenantId, id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    if (!isAdminReq(req)) {
      const proof = String(req.query.proofEmail || "");
      if (!matchesProofEmail(profile.email, proof)) {
        return res.status(403).json({ error: "Verification failed. Please match the email on file." });
      }
    }
    if (profile.photoPath) {
      const oldName = path.basename(profile.photoPath);
      const oldPath = path.join(PHOTO_DIR, oldName);
      try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch {}
    }
    const updated = storage.updateProfile(tenantId, id, { photoPath: "" });
    res.json({ ok: true, profile: updated });
  });

  // ===== Coaching notes thread =====
  // List notes for a profile. Admin OR customer with matching proofEmail.
  app.get("/api/notes/:profileId", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const profileId = Number(req.params.profileId);
    const profile = storage.getProfileById(tenantId, profileId);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    if (!isAdminReq(req)) {
      const proof = String(req.query.proofEmail || "");
      if (!matchesProofEmail(profile.email, proof)) {
        return res.status(403).json({ error: "Verification failed." });
      }
    }
    res.json({ notes: storage.getNotesForProfile(tenantId, profileId) });
  });

  // Static file serving for note attachments. Path tokens are unguessable.
  app.use("/uploads/notes", express.static(NOTES_DIR, {
    setHeaders: (res) => { res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); },
  }));

  // Post a note. Admin posts as "coach"; customer (with proofEmail) posts as "parent".
  // Accepts multipart/form-data with optional `file` (image/video) or `mediaUrl` (link).
  // Sends an email alert to the OTHER party.
  app.post("/api/notes/:profileId", noteUpload.single("file"), async (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const profileId = Number(req.params.profileId);
    const profile = storage.getProfileById(tenantId, profileId);
    if (!profile) {
      if (req.file) { try { fs.unlinkSync(path.join(NOTES_DIR, req.file.filename)); } catch {} }
      return res.status(404).json({ error: "Profile not found" });
    }

    const text = String(req.body?.text || "").trim();
    const mediaUrlInput = String(req.body?.mediaUrl || "").trim();
    const hasFile = !!req.file;
    if (!text && !hasFile && !mediaUrlInput) {
      return res.status(400).json({ error: "Add a message, attach a file, or paste a video link." });
    }
    if (text.length > 5000) {
      if (req.file) { try { fs.unlinkSync(path.join(NOTES_DIR, req.file.filename)); } catch {} }
      return res.status(400).json({ error: "Note is too long (5000 char max)." });
    }
    if (mediaUrlInput && !/^https?:\/\//i.test(mediaUrlInput)) {
      if (req.file) { try { fs.unlinkSync(path.join(NOTES_DIR, req.file.filename)); } catch {} }
      return res.status(400).json({ error: "Video link must start with http:// or https://" });
    }

    const admin = isAdminReq(req);
    let author: "coach" | "parent";
    if (admin) {
      author = "coach";
    } else {
      const proof = String(req.body?.proofEmail || "");
      if (!matchesProofEmail(profile.email, proof)) {
        if (req.file) { try { fs.unlinkSync(path.join(NOTES_DIR, req.file.filename)); } catch {} }
        return res.status(403).json({ error: "Verification failed. Please match the email on file." });
      }
      author = "parent";
    }

    let mediaType: string | null = null;
    let mediaPath: string | null = null;
    let mediaUrl: string | null = null;
    if (hasFile && req.file) {
      mediaType = /^video\//.test(req.file.mimetype) ? "video" : "image";
      mediaPath = req.file.filename;
    } else if (mediaUrlInput) {
      mediaType = "link";
      mediaUrl = mediaUrlInput;
    }

    const note = storage.addNote(tenantId, { profileId, author, text, mediaType, mediaPath, mediaUrl } as any);

    // Fire-and-forget email alert to the OTHER party
    const coachName = getSetting("coachName") || "Coach Skinner";
    const siteBase = (process.env.PUBLIC_SITE_URL || getSetting("publicSiteUrl") || "").replace(/\/$/, "");
    const manageUrl = siteBase + "/#/my-appointments";
    const brand = "#1f5a37";
    const safeText = text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
    const playerLabel = profile.playerName || profile.parentName || "player";

    // Build a media block for the email. Email clients strip <video>, so we
    // render a clickable thumbnail/button that opens the media in the browser.
    let mediaBlockHtml = "";
    let mediaBlockText = "";
    if (mediaType === "image" && mediaPath) {
      const imgUrl = `${siteBase}/uploads/notes/${mediaPath}`;
      mediaBlockHtml = `<div style="margin-top:16px"><a href="${manageUrl}" style="display:block"><img src="${imgUrl}" alt="Attached photo" style="max-width:100%;border-radius:8px;border:1px solid #e5e7eb" /></a><p style="margin:8px 0 0;color:#888;font-size:13px">Photo attached — <a href="${manageUrl}" style="color:${brand}">open in app</a></p></div>`;
      mediaBlockText = `\n\nA photo was attached. View it here: ${imgUrl}`;
    } else if (mediaType === "video" && mediaPath) {
      const videoUrl = `${siteBase}/uploads/notes/${mediaPath}`;
      mediaBlockHtml = `<div style="margin-top:16px;background:#f7f8f6;border:1px solid #e5e7eb;border-radius:8px;padding:18px;text-align:center"><div style="font-size:36px;line-height:1;margin-bottom:8px">▶</div><div style="font-weight:600;margin-bottom:4px">Video attached</div><div style="color:#555;font-size:13px;margin-bottom:14px">Videos can't play inside email. Tap below to watch.</div><a href="${videoUrl}" style="background:${brand};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-weight:600">Watch video</a><div style="margin-top:10px;font-size:13px"><a href="${manageUrl}" style="color:${brand}">or open in app</a></div></div>`;
      mediaBlockText = `\n\nA video was attached. Watch it here: ${videoUrl}`;
    } else if (mediaType === "link" && mediaUrl) {
      mediaBlockHtml = `<div style="margin-top:16px;background:#f7f8f6;border:1px solid #e5e7eb;border-radius:8px;padding:18px;text-align:center"><div style="font-size:36px;line-height:1;margin-bottom:8px">▶</div><div style="font-weight:600;margin-bottom:4px">Video link attached</div><a href="${mediaUrl}" style="background:${brand};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-weight:600;margin-top:8px">Watch video</a></div>`;
      mediaBlockText = `\n\nA video link was shared: ${mediaUrl}`;
    }

    (async () => {
      try {
        if (author === "coach" && profile.email) {
          // Notify the parent
          await sendEmail({
            to: profile.email,
            subject: `New note from ${coachName} about ${playerLabel}`,
            text: `${coachName} posted a new note in ${playerLabel}'s coaching thread:\n\n${text || "(no message)"}${mediaBlockText}\n\nReply at: ${manageUrl}`,
            html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
              <h2 style="color:${brand};margin:0 0 8px">New note from ${coachName}</h2>
              <p style="margin:0 0 16px;color:#555">About <strong>${playerLabel}</strong></p>
              ${safeText ? `<div style="background:#f7f8f6;border-left:4px solid ${brand};padding:14px 16px;border-radius:6px;white-space:pre-wrap">${safeText}</div>` : ""}
              ${mediaBlockHtml}
              <p style="margin:20px 0 0"><a href="${manageUrl}" style="background:${brand};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">Reply to ${coachName}</a></p>
              <p style="margin:24px 0 0;color:#888;font-size:13px">You're receiving this because ${coachName} posted a coaching note for ${playerLabel}.</p>
            </div>`,
          });
        } else if (author === "parent") {
          // Notify all admin recipients
          const noteRecipients = getBookingEmailRecipients(tenantId);
          for (const noteRecipient of noteRecipients) {
            await sendEmail({
              to: noteRecipient,
              subject: `New note from ${profile.parentName || "a parent"} about ${playerLabel}`,
              text: `${profile.parentName || "A parent"} posted a new note about ${playerLabel}:\n\n${text || "(no message)"}${mediaBlockText}\n\nReply at: ${manageUrl}`,
              html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
              <h2 style="color:${brand};margin:0 0 8px">New note from ${profile.parentName || "a parent"}</h2>
              <p style="margin:0 0 16px;color:#555">About <strong>${playerLabel}</strong></p>
              ${safeText ? `<div style="background:#f7f8f6;border-left:4px solid ${brand};padding:14px 16px;border-radius:6px;white-space:pre-wrap">${safeText}</div>` : ""}
              ${mediaBlockHtml}
              <p style="margin:20px 0 0"><a href="${manageUrl}" style="background:${brand};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">Open admin</a></p>
            </div>`,
            });
          }
        }
      } catch (e) { console.error("note email failed:", e); }
    })();

    res.json({ ok: true, note });
  });

  // Delete a note. Admin only (simplest; matches scope).
  app.delete("/api/notes/:noteId", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const id = Number(req.params.noteId);
    const existing = storage.getNoteById(tenantId, id);
    if (existing?.mediaPath) {
      try { fs.unlinkSync(path.join(NOTES_DIR, existing.mediaPath)); } catch {}
    }
    storage.deleteNote(tenantId, id);
    res.json({ ok: true });
  });

  // Admin: list all profiles with booking stats
  app.get("/api/admin/profiles", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const all = storage.getAllProfiles(tenantId);
    const now = new Date().toISOString();
    const out = all.map((p) => {
      const bks = storage.getBookingsForProfile(tenantId, p.id);
      const sorted = bks.slice().sort((a, b) => (a.start < b.start ? 1 : -1));
      const upcoming = bks.filter((b) => b.start >= now);
      return {
        ...p,
        bookingCount: bks.length,
        upcomingCount: upcoming.length,
        lastBookingStart: sorted[0]?.start ?? null,
      };
    });
    res.json({ profiles: out });
  });

  // Admin: delete a profile and all associated bookings/notes/photo
  app.delete("/api/admin/profiles/:id", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const id = Number(req.params.id);
    const profile = storage.getProfileById(tenantId, id);
    if (!profile) return res.status(404).json({ error: "Not found" });
    const bks = storage.getBookingsForProfile(tenantId, id);
    for (const b of bks) {
      try { cancelRemindersForBooking(b.id); } catch {}
      storage.deleteBooking(tenantId, b.id);
    }
    const notes = storage.getNotesForProfile(tenantId, id);
    for (const n of notes) storage.deleteNote(tenantId, n.id);
    if (profile.photoPath) {
      const filename = profile.photoPath.replace(/^\/uploads\/photos\//, "");
      try { fs.unlinkSync(path.join(PHOTO_DIR, filename)); } catch {}
    }
    storage.deleteProfile(tenantId, id);
    res.json({ ok: true });
  });

  app.post("/api/settings/test-email", requireAdmin, async (_req, res) => {
    const to = getSetting("coachEmail");
    if (!to) return res.status(400).json({ error: "Set coach email first" });
    const result = await sendBookingEmail({
      to,
      subject: "Test — Coach Skinner Lessons booking app",
      text: "This is a test email from your booking app. If you see this, email confirmations are working.",
      html: "<p>This is a test email from your booking app. If you see this, email confirmations are working.</p>",
      icsContent: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR",
      icsFilename: "test.ics",
    });
    res.json(result);
  });

  // ===== Resource library =====
  // Serve uploaded resource files publicly (gated by app at the API/UI level)
  app.use("/uploads/resources", express.static(RESOURCE_DIR, {
    maxAge: "7d",
    setHeaders: (res) => { res.setHeader("Cache-Control", "public, max-age=604800"); },
  }));

  // Public-but-gated: any signed-up parent (proves email) OR admin can list resources
  app.get("/api/resources", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const proof = String(req.query.proofEmail || "").trim().toLowerCase();
    if (!isAdminReq(req)) {
      if (!proof) return res.status(401).json({ error: "Sign up or sign in to view resources." });
      const prof = storage.getProfileByEmail(tenantId, proof);
      if (!prof) return res.status(403).json({ error: "We couldn't find a profile with that email. Book your first lesson to get access." });
    }
    const list = storage.getResources(tenantId);
    // Categories now come from per-tenant resource_categories table.  Map to
    // the legacy { id, label } shape the client expects.
    const cats = sqlite.prepare(
      `SELECT slug as id, label FROM resource_categories WHERE tenant_id = ? ORDER BY sort_order ASC, id ASC`,
    ).all(tenantId) as { id: string; label: string }[];
    res.json({ resources: list, categories: cats });
  });

  // Admin: create a resource (link, or upload)
  app.post("/api/admin/resources", requireAdmin, resourceUpload.single("file"), (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    try {
      const body = req.body || {};
      const type = String(body.type || "");
      const category = String(body.category || "general");
      const title = String(body.title || "").trim();
      const description = String(body.description || "").trim();
      const urlIn = String(body.url || "").trim();
      if (!title) return res.status(400).json({ error: "Title is required" });
      if (!["pdf", "link", "image", "video"].includes(type)) return res.status(400).json({ error: "Invalid type" });
      const validCats = (sqlite.prepare(
        `SELECT slug FROM resource_categories WHERE tenant_id = ?`,
      ).all(tenantId) as { slug: string }[]).map(r => r.slug);
      if (!validCats.includes(category)) return res.status(400).json({ error: "Invalid category" });

      let url = "";
      let filePath = "";
      if (type === "link") {
        if (!/^https?:\/\//i.test(urlIn)) return res.status(400).json({ error: "Link must start with http:// or https://" });
        url = urlIn;
      } else {
        if (!req.file) return res.status(400).json({ error: "File is required" });
        filePath = req.file.filename;
        url = `/uploads/resources/${req.file.filename}`;
      }
      const parsed = insertResourceSchema.parse({ type, category, title, description, url, filePath });
      const r = storage.createResource(tenantId, parsed);
      res.json({ resource: r });
    } catch (e: any) {
      // Clean up uploaded file if validation failed
      if (req.file) { try { fs.unlinkSync(path.join(RESOURCE_DIR, req.file.filename)); } catch {} }
      res.status(400).json({ error: e?.message || "Couldn't create resource" });
    }
  });

  app.patch("/api/admin/resources/:id", requireAdmin, resourceUpload.single("file"), (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    try {
      const id = Number(req.params.id);
      const existing = storage.getResourceById(tenantId, id);
      if (!existing) return res.status(404).json({ error: "Not found" });
      const body = req.body || {};
      const patch: any = {};
      if (typeof body.title === "string") {
        const t = body.title.trim();
        if (!t) return res.status(400).json({ error: "Title is required" });
        patch.title = t;
      }
      if (typeof body.description === "string") patch.description = body.description.trim();
      if (typeof body.category === "string") {
        const validCats = (sqlite.prepare(
          `SELECT slug FROM resource_categories WHERE tenant_id = ?`,
        ).all(tenantId) as { slug: string }[]).map(r => r.slug);
        if (!validCats.includes(body.category)) return res.status(400).json({ error: "Invalid category" });
        patch.category = body.category;
      }
      // Link URL edit (only when existing is a link)
      if (existing.type === "link" && typeof body.url === "string") {
        const u = body.url.trim();
        if (!/^https?:\/\//i.test(u)) return res.status(400).json({ error: "Link must start with http:// or https://" });
        patch.url = u;
      }
      // File replacement (only when existing is file-backed and a new file was uploaded)
      if (existing.type !== "link" && req.file) {
        // Remove old file
        if (existing.filePath) { try { fs.unlinkSync(path.join(RESOURCE_DIR, existing.filePath)); } catch {} }
        patch.filePath = req.file.filename;
        patch.url = `/uploads/resources/${req.file.filename}`;
      }
      const updated = storage.updateResource(tenantId, id, patch);
      res.json({ resource: updated });
    } catch (e: any) {
      if (req.file) { try { fs.unlinkSync(path.join(RESOURCE_DIR, req.file.filename)); } catch {} }
      res.status(400).json({ error: e?.message || "Couldn't update resource" });
    }
  });

  app.delete("/api/admin/resources/:id", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const id = Number(req.params.id);
    const r = storage.getResourceById(tenantId, id);
    if (!r) return res.status(404).json({ error: "Not found" });
    if (r.filePath) {
      try { fs.unlinkSync(path.join(RESOURCE_DIR, r.filePath)); } catch {}
    }
    storage.deleteResource(tenantId, id);
    res.json({ ok: true });
  });

  // ===== Per-tenant resource categories =====
  // Coaches can add/rename/delete their own categories.  Slugs are unique
  // per tenant.  Default categories are seeded at signup based on sport.
  app.get("/api/admin/resource-categories", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const rows = sqlite.prepare(
      `SELECT id, slug, label, sort_order FROM resource_categories WHERE tenant_id = ? ORDER BY sort_order ASC, id ASC`,
    ).all(tenantId);
    res.json({ categories: rows });
  });

  app.post("/api/admin/resource-categories", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const label = String(req.body?.label || "").trim();
    if (!label) return res.status(400).json({ error: "Label is required" });
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "category";
    // Ensure unique slug within tenant
    const taken = sqlite.prepare(
      `SELECT 1 FROM resource_categories WHERE tenant_id = ? AND slug = ? LIMIT 1`,
    ).get(tenantId, slug);
    if (taken) return res.status(409).json({ error: "A category with that name already exists." });
    const max = (sqlite.prepare(
      `SELECT COALESCE(MAX(sort_order), -1) as m FROM resource_categories WHERE tenant_id = ?`,
    ).get(tenantId) as { m: number }).m;
    const info = sqlite.prepare(
      `INSERT INTO resource_categories (tenant_id, slug, label, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(tenantId, slug, label, max + 1, Date.now());
    res.json({ category: { id: info.lastInsertRowid, slug, label } });
  });

  app.patch("/api/admin/resource-categories/:id", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const id = Number(req.params.id);
    const label = String(req.body?.label || "").trim();
    if (!label) return res.status(400).json({ error: "Label is required" });
    const info = sqlite.prepare(
      `UPDATE resource_categories SET label = ? WHERE tenant_id = ? AND id = ?`,
    ).run(label, tenantId, id);
    if (info.changes === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  });

  app.delete("/api/admin/resource-categories/:id", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const id = Number(req.params.id);
    // Find the slug so we can check if any resources still use it
    const row = sqlite.prepare(
      `SELECT slug FROM resource_categories WHERE tenant_id = ? AND id = ?`,
    ).get(tenantId, id) as { slug: string } | undefined;
    if (!row) return res.status(404).json({ error: "Not found" });
    const inUse = sqlite.prepare(
      `SELECT COUNT(*) AS c FROM resources WHERE tenant_id = ? AND category = ?`,
    ).get(tenantId, row.slug) as { c: number };
    if (inUse.c > 0) {
      return res.status(409).json({ error: `Can't delete — ${inUse.c} resource(s) still use this category. Move them first.` });
    }
    sqlite.prepare(`DELETE FROM resource_categories WHERE tenant_id = ? AND id = ?`).run(tenantId, id);
    res.json({ ok: true });
  });

  // ===== Lesson types (per tenant) =====
  // Public list of active lesson types — used by booking page to render options.
  // ?coachId= optional: filter to that coach. If omitted, defaults to solo coach (back-compat).
  app.get("/api/lesson-types", (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    let ltAdminUserId: number | undefined;
    const coachIdParam = req.query.coachId;
    if (coachIdParam !== undefined && coachIdParam !== "") {
      ltAdminUserId = Number(coachIdParam);
    } else {
      const solo = getSoloCoach(tenantId);
      if (solo) ltAdminUserId = solo.id;
    }
    const types = storage.listLessonTypes(tenantId, { activeOnly: true, adminUserId: ltAdminUserId });
    res.json({ lessonTypes: types });
  });
  // Admin list (includes inactive). ?coachId= optional for per-coach view.
  app.get("/api/admin/lesson-types", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    let ltAdminUserId: number | undefined;
    const coachIdParam = req.query.coachId;
    if (coachIdParam !== undefined && coachIdParam !== "") {
      ltAdminUserId = Number(coachIdParam);
    }
    res.json({ lessonTypes: storage.listLessonTypes(tenantId, { adminUserId: ltAdminUserId }) });
  });
  app.post("/api/admin/lesson-types", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const parsed = insertLessonTypeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const v = parsed.data;
    if (v.durationMin % 30 !== 0 || v.durationMin <= 0) {
      return res.status(400).json({ error: "Duration must be a positive multiple of 30 minutes." });
    }
    if (v.capacity < 1) return res.status(400).json({ error: "Capacity must be at least 1." });
    // Resolve coachId for new lesson type — defaults to solo coach
    let ltCreateAdminUserId: number | undefined;
    const coachIdBody = req.body?.coachId;
    if (coachIdBody !== undefined && coachIdBody !== null && coachIdBody !== "") {
      const resolved = resolveCoachId(req, res, tenantId, { required: false, requireGivesLessons: false });
      if (resolved === null) return;
      ltCreateAdminUserId = resolved ?? undefined;
    } else {
      const solo = getSoloCoach(tenantId);
      if (solo) ltCreateAdminUserId = solo.id;
    }
    const created = storage.createLessonType(tenantId, v, ltCreateAdminUserId);
    res.json({ lessonType: created });
  });
  app.patch("/api/admin/lesson-types/:id", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const id = Number(req.params.id);
    const partial = insertLessonTypeSchema.partial().safeParse(req.body);
    if (!partial.success) return res.status(400).json({ error: partial.error.flatten() });
    const v = partial.data;
    if (v.durationMin !== undefined && (v.durationMin % 30 !== 0 || v.durationMin <= 0)) {
      return res.status(400).json({ error: "Duration must be a positive multiple of 30 minutes." });
    }
    if (v.capacity !== undefined && v.capacity < 1) {
      return res.status(400).json({ error: "Capacity must be at least 1." });
    }
    const updated = storage.updateLessonType(tenantId, id, v);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json({ lessonType: updated });
  });
  app.delete("/api/admin/lesson-types/:id", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const id = Number(req.params.id);
    // Safety: check if any bookings reference this lesson type.
    const inUse = sqlite.prepare(
      `SELECT COUNT(*) AS c FROM bookings WHERE tenant_id = ? AND lesson_type_id = ?`,
    ).get(tenantId, id) as { c: number };
    if (inUse.c > 0) {
      return res.status(409).json({
        error: `Can't delete — ${inUse.c} booking(s) reference this lesson type. Deactivate it instead.`,
      });
    }
    storage.deleteLessonType(tenantId, id);
    res.json({ ok: true });
  });

  // ===== Admin team management =====
  app.get("/api/admin/team", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    const admins = listAdminUsers(tenantId);
    // Annotate each admin with availability + lesson-type counts so the UI can
    // warn when a lesson-giving coach has no schedule set yet (bookings would
    // appear as "No sessions available" to the public).
    const avail = sqlite.prepare(
      `SELECT admin_user_id as adminUserId, COUNT(*) as n FROM availability WHERE tenant_id=? GROUP BY admin_user_id`
    ).all(tenantId) as { adminUserId: number | null; n: number }[];
    const lt = sqlite.prepare(
      `SELECT admin_user_id as adminUserId, COUNT(*) as n FROM lesson_types WHERE tenant_id=? AND active=1 GROUP BY admin_user_id`
    ).all(tenantId) as { adminUserId: number | null; n: number }[];
    const availMap = new Map<number, number>();
    for (const r of avail) if (r.adminUserId !== null) availMap.set(r.adminUserId, r.n);
    const ltMap = new Map<number, number>();
    for (const r of lt) if (r.adminUserId !== null) ltMap.set(r.adminUserId, r.n);
    const annotated = admins.map(a => ({
      ...a,
      availabilityCount: availMap.get(a.id) ?? 0,
      lessonTypeCount: ltMap.get(a.id) ?? 0,
    }));
    res.json({ admins: annotated });
  });

  app.post("/api/admin/team", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    try {
      const phone = String(req.body?.phone || "");
      const name = String(req.body?.name || "");
      const email = String(req.body?.email || "").trim();
      const password = String(req.body?.password || "");
      if (!email) return res.status(400).json({ error: "Email is required" });
      const givesLessons = !!req.body?.givesLessons;
      const receivesEmails = !!req.body?.receivesEmails;
      const user = addAdminUser(tenantId, { phone, name, email, password, givesLessons, receivesEmails });
      res.json({ admin: user });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || "Couldn't add admin" });
    }
  });

  app.patch("/api/admin/team/:id", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    try {
      const id = Number(req.params.id);
      const patch: { name?: string; email?: string; givesLessons?: boolean; receivesEmails?: boolean; color?: string; password?: string } = {};
      if (req.body?.name !== undefined) patch.name = String(req.body.name);
      if (req.body?.email !== undefined) patch.email = String(req.body.email);
      if (req.body?.givesLessons !== undefined) patch.givesLessons = !!req.body.givesLessons;
      if (req.body?.receivesEmails !== undefined) patch.receivesEmails = !!req.body.receivesEmails;
      if (req.body?.color !== undefined) patch.color = String(req.body.color);
      if (req.body?.password !== undefined) patch.password = String(req.body.password);
      const user = updateAdminUser(tenantId, id, patch);
      res.json({ admin: user });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || "Couldn't update admin" });
    }
  });

  app.delete("/api/admin/team/:id", requireAdmin, (req, res) => {
    const tenantId = requireTenantId(req, res); if (tenantId === null) return;
    try {
      const id = Number(req.params.id);
      deleteAdminUser(tenantId, id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || "Couldn't remove admin" });
    }
  });

  return httpServer;
}
