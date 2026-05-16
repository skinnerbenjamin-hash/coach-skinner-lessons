import type { Express, Request } from "express";
import type { Server } from 'node:http';
import { storage } from "./storage";
import {
  checkoutSchema, insertAvailabilitySchema, insertDateOverrideSchema,
  insertProfileSchema, normalizePhone,
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
  listAdminUsers, addAdminUser, deleteAdminUser,
} from "./auth";
import { insertResourceSchema, RESOURCE_CATEGORIES } from "@shared/schema";

startReminderLoop();
seedDefaultAdmin("9079527860", "1qaz!QAZ");

const SLOT_MIN = 30;
const MAX_GAP_MIN = 30;          // gaps <= this between busy blocks count as "orphan"
const CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h cutoff
const MAX_BOOKING_DAYS = 30; // customers can book up to ~1 month ahead
const MAX_BOOKING_WINDOW_MS = MAX_BOOKING_DAYS * 24 * 60 * 60 * 1000;

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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf" || /^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only PDF or image uploads are allowed."));
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

// open windows (in minutes-from-midnight) for a given local date
function openWindowsForDate(date: string) {
  const overrides = storage.getDateOverrides().filter(o => o.date === date);
  if (overrides.some(o => o.type === "closed")) return [];
  const dow = dayOfWeek(date);
  const base = storage.getAvailability().filter(a => a.dayOfWeek === dow);
  const wins = base.map(b => ({ start: timeToMin(b.startTime), end: timeToMin(b.endTime) }));
  for (const o of overrides) {
    if (o.type === "extra" && o.startTime && o.endTime) {
      wins.push({ start: timeToMin(o.startTime), end: timeToMin(o.endTime) });
    }
  }
  wins.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const w of wins) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }
  return merged;
}

function slotsForDate(date: string) {
  const out: string[] = [];
  for (const w of openWindowsForDate(date)) {
    for (let m = w.start; m + SLOT_MIN <= w.end; m += SLOT_MIN) out.push(toIso(date, minToTime(m)));
  }
  return out;
}

function availabilityForRange(startDate: string, endDate: string) {
  const all = storage.getBookingsInRange(startDate + "T00:00", endDate + "T23:59");
  const bookedSet = new Set(all.map(b => b.start));
  const days: { date: string; slots: { start: string; booked: boolean }[] }[] = [];
  let cur = startDate;
  while (cur <= endDate) {
    days.push({ date: cur, slots: slotsForDate(cur).map(s => ({ start: s, booked: bookedSet.has(s) })) });
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

function detectGaps(selectedSlots: string[], excludeBookingIds: number[] = []): GapWarning[] {
  const warnings: GapWarning[] = [];
  const byDate = new Map<string, string[]>();
  for (const s of selectedSlots) {
    if (!byDate.has(isoDate(s))) byDate.set(isoDate(s), []);
    byDate.get(isoDate(s))!.push(s);
  }
  for (const [date, userSlots] of byDate) {
    const windows = openWindowsForDate(date);
    if (!windows.length) continue;
    const existing = storage.getBookingsInRange(date + "T00:00", date + "T23:59")
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

function isWithin24h(iso: string): boolean {
  const start = isoToLocalDate(iso).getTime();
  return start - Date.now() < CANCEL_WINDOW_MS;
}

function isBeyondMaxWindow(iso: string): boolean {
  const start = isoToLocalDate(iso).getTime();
  return start - Date.now() > MAX_BOOKING_WINDOW_MS;
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // --- Health check (used by Render) ---
  app.get("/healthz", (_req, res) => res.status(200).send("ok"));
  // --- Auth ---
  app.post("/api/auth/login", (req, res) => {
    const { phone, password } = req.body || {};
    if (typeof phone !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "phone and password required" });
    }
    const result = checkLogin(phone, password);
    if (!result.ok) return res.status(401).json({ error: "Invalid phone or password" });
    setSessionCookie(res, result.token);
    res.json({ ok: true });
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
    const verify = checkLogin(currentPhone, currentPassword);
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

  // Availability
  app.get("/api/availability", (_req, res) => {
    res.json({ weekly: storage.getAvailability(), overrides: storage.getDateOverrides() });
  });
  app.put("/api/availability", requireAdmin, (req, res) => {
    const parsed = z.array(insertAvailabilitySchema).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    storage.setAvailability(parsed.data);
    res.json({ ok: true });
  });
  app.post("/api/overrides", requireAdmin, async (req, res) => {
    const parsed = insertDateOverrideSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const override = storage.addDateOverride(parsed.data);

    // If this is a 'closed' blackout, cancel every booking on that date and notify the parents
    // via the configured reminder channel (email by default, with SMS fallback).
    const cancelled: { id: number; start: string; playerName: string; parentName: string; phone: string; email: string; notified: boolean; notifyError?: string }[] = [];
    if (parsed.data.type === "closed") {
      const date = parsed.data.date;
      const onDate = storage.getBookingsInRange(date + "T00:00", date + "T23:59")
        .map(b => storage.expandBooking(b))
        .sort((a, b) => a.start.localeCompare(b.start));
      // group by profileId so each parent gets ONE notification covering all of their cancelled sessions
      const byProfile = new Map<number, typeof onDate>();
      for (const b of onDate) {
        if (!byProfile.has(b.profileId)) byProfile.set(b.profileId, []);
        byProfile.get(b.profileId)!.push(b);
      }
      const coachName = getSetting("coachName") || "Coach Skinner";
      const dateLong = formatDateLong(date);
      const channel = (getSetting("reminderChannel") || "email").toLowerCase();
      const manageUrl = (process.env.PUBLIC_SITE_URL || getSetting("publicSiteUrl") || "").replace(/\/$/, "") + "/#/my-appointments";
      for (const [_profileId, rows] of byProfile) {
        const phone = rows[0].phone;
        const email = rows[0].email;
        const times = rows.map(r => formatTime(r.start.split("T")[1])).join(", ");
        const playerNames = Array.from(new Set(rows.map(r => r.playerName))).join(" & ");
        const msg = `Really sorry — ${coachName} has to cancel lessons on ${dateLong}. Affected: ${playerNames} at ${times}. Please reach out to reschedule.`;

        let okAny = false;
        let errParts: string[] = [];
        if ((channel === "email" || channel === "both") && email) {
          const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f1a14;"><div style="max-width:560px;margin:0 auto;padding:24px 16px;"><div style="background:#ffffff;border-radius:12px;padding:24px;"><div style="font-size:20px;font-weight:600;color:#a33;margin-bottom:12px;">Lesson cancelled — ${dateLong}</div><p style="font-size:16px;line-height:1.5;margin:0 0 12px 0;">${msg}</p><p style="font-size:14px;color:#525f57;margin:8px 0 24px 0;">Sessions cancelled: <b>${playerNames}</b> at <b>${times}</b>.</p><div style="text-align:center;margin:24px 0;"><a href="${manageUrl}" style="display:inline-block;background:#1f5a37;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;">Book a different time</a></div></div></div></body></html>`;
          const r = await sendEmail({
            to: email,
            subject: `Cancelled: ${dateLong} lesson with ${coachName}`,
            html,
            text: `${msg}\n\nBook a different time: ${manageUrl}`,
          });
          if (r.ok) okAny = true; else errParts.push(`email: ${r.error}`);
        }
        if ((channel === "sms" || channel === "both") && phone) {
          const r = await sendSms(phone, `${msg} Reply STOP to opt out.`);
          if (r.ok) okAny = true; else errParts.push(`sms: ${r.error}`);
        }
        for (const r of rows) {
          cancelRemindersForBooking(r.id);
          storage.deleteBooking(r.id);
          cancelled.push({
            id: r.id, start: r.start, playerName: r.playerName, parentName: r.parentName,
            phone, email,
            notified: okAny, notifyError: okAny ? undefined : (errParts.join("; ") || "No channel configured"),
          });
        }
      }
    }
    res.json({ override, cancelledBookings: cancelled });
  });
  app.delete("/api/overrides/:id", requireAdmin, (req, res) => {
    storage.deleteDateOverride(Number(req.params.id));
    res.json({ ok: true });
  });

  // Slot list (public)
  app.get("/api/slots", (req, res) => {
    const start = String(req.query.start || "");
    const end = String(req.query.end || "");
    if (!start || !end) return res.status(400).json({ error: "start and end required" });
    // Cap end at MAX_BOOKING_DAYS from now for non-admin requests
    const isAdmin = !!(req as any).session?.admin;
    let effectiveEnd = end;
    if (!isAdmin) {
      const maxEndMs = Date.now() + MAX_BOOKING_WINDOW_MS;
      const requestedEndMs = new Date(end).getTime();
      if (requestedEndMs > maxEndMs) {
        effectiveEnd = new Date(maxEndMs).toISOString();
      }
    }
    res.json({ days: availabilityForRange(start, effectiveEnd), maxBookingDays: MAX_BOOKING_DAYS });
  });

  // Profiles
  app.get("/api/profile/:phone", (req, res) => {
    const p = storage.getProfileByPhone(req.params.phone);
    if (!p) return res.status(404).json({ error: "Not found" });
    res.json(p);
  });
  app.post("/api/profile", (req, res) => {
    const parsed = insertProfileSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    res.json(storage.upsertProfile(parsed.data));
  });

  // Gap check (used at review step)
  app.post("/api/check-gaps", (req, res) => {
    const parsed = z.object({
      slots: z.array(z.string()),
      excludeBookingIds: z.array(z.number()).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid" });
    res.json({ warnings: detectGaps(parsed.data.slots, parsed.data.excludeBookingIds ?? []) });
  });

  // Checkout
  app.post("/api/bookings", (req, res) => {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { slots, phone, email, parentName, playerName, notes } = parsed.data;
    const isAdmin = isAdminReq(req);
    // upsert profile
    const profile = storage.upsertProfile({ phone: normalizePhone(phone), email, parentName, playerName, notes });
    // Customers can't book inside 24h or beyond MAX_BOOKING_DAYS; admins bypass both.
    if (!isAdmin && slots.some(s => isWithin24h(s))) {
      return res.status(400).json({ error: "Bookings must be at least 24 hours in advance." });
    }
    if (!isAdmin && slots.some(s => isBeyondMaxWindow(s))) {
      return res.status(400).json({ error: `Bookings can be made up to ${MAX_BOOKING_DAYS} days in advance.` });
    }
    // collision check
    const existing = storage.getBookingsByStarts(slots);
    if (existing.length) {
      return res.status(409).json({
        error: "Some times were just taken. Please refresh and choose again.",
        takenSlots: existing.map(b => b.start),
      });
    }
    const bookingGroup = randomUUID();
    const rows = storage.createBookings(slots.map(s => ({
      start: s, profileId: profile.id, bookingGroup, createdAt: Date.now(),
    })));
    for (const r of rows) {
      scheduleRemindersForBooking(r.id, r.start, profile.phone, profile.playerName, profile.email);
    }
    const expanded = rows.map(r => storage.expandBooking(r));
    const ics = icsForBookings(expanded);
    const coachName = getSetting("coachName") || "Coach Skinner";
    const manageUrl = (process.env.PUBLIC_SITE_URL || getSetting("publicSiteUrl") || "").replace(/\/$/, "") + "/#/my-appointments";

    // Coach notification email (fire-and-forget)
    const coachEmail = getSetting("coachEmail");
    if (coachEmail) {
      const summary = expanded.map(b => `• ${b.start.replace("T", " ")}`).join("\n");
      sendBookingEmail({
        to: coachEmail,
        subject: `New booking: ${profile.playerName} (${expanded.length} session${expanded.length === 1 ? "" : "s"})`,
        text: `New softball lesson booking.\n\nPlayer: ${profile.playerName}\nParent: ${profile.parentName}\nPhone: ${profile.phone}\nEmail: ${profile.email}\nNotes: ${profile.notes || "(none)"}\n\nSessions:\n${summary}\n\nThe attached .ics file will add these to your Apple Calendar.`,
        html: `<p>New softball lesson booking.</p><ul><li><b>Player:</b> ${profile.playerName}</li><li><b>Parent:</b> ${profile.parentName}</li><li><b>Phone:</b> ${profile.phone}</li><li><b>Email:</b> ${profile.email}</li><li><b>Notes:</b> ${profile.notes || "(none)"}</li></ul><p><b>Sessions:</b></p><pre>${summary}</pre><p>The attached .ics file will add these to your Apple Calendar.</p>`,
        icsContent: ics,
        icsFilename: `booking-${bookingGroup.slice(0, 8)}.ics`,
      }).catch(e => console.error("coach email send error:", e));
    }

    // Parent confirmation — channel decided by setting
    const channel = (getSetting("reminderChannel") || "email").toLowerCase();
    const sessionLines = expanded
      .slice()
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(b => `• ${formatDateLong(isoDate(b.start))} — ${formatTime(b.start.split("T")[1])}`)
      .join("\n");
    const sessionLinesHtml = expanded
      .slice()
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(b => `<li>${formatDateLong(isoDate(b.start))} — ${formatTime(b.start.split("T")[1])}</li>`)
      .join("");

    if ((channel === "email" || channel === "both") && profile.email) {
      const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f1a14;">
        <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
          <div style="background:#ffffff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
            <div style="font-size:20px;font-weight:600;margin-bottom:12px;color:#1f5a37;">${coachName} · Softball Lessons</div>
            <p style="font-size:16px;margin:0 0 8px 0;">You're booked! Here are <b>${profile.playerName}</b>'s confirmed sessions:</p>
            <ul style="font-size:16px;line-height:1.7;margin:8px 0 16px 18px;padding:0;">${sessionLinesHtml}</ul>
            <p style="font-size:14px;color:#525f57;margin:0 0 16px 0;">A calendar file (.ics) is attached — open it on your phone or laptop to add these to your calendar.</p>
            <div style="text-align:center;margin:28px 0;">
              <a href="${manageUrl}" style="display:inline-block;background:#1f5a37;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:16px;">Manage your appointments</a>
            </div>
            <div style="background:#f0f6f2;border-left:4px solid #1f5a37;padding:12px 16px;border-radius:6px;margin:16px 0;">
              <div style="font-weight:600;font-size:14px;margin-bottom:4px;">Need to change or cancel?</div>
              <div style="font-size:14px;line-height:1.5;color:#3a4540;">You can do it yourself anytime up to <b>24 hours before</b> the session. Just open the link above and use the email you booked with (${profile.email || "your booking email"}). Save this email — the link works any time.</div>
            </div>
            <div style="background:#fff4e8;border-left:4px solid #d18e1c;padding:12px 16px;border-radius:6px;margin:12px 0;">
              <div style="font-weight:600;font-size:14px;margin-bottom:4px;">Cancellation policy</div>
              <div style="font-size:14px;line-height:1.5;color:#3a4540;">Cancellations or no-shows within <b>24 hours</b> of the scheduled session are subject to a <b>$30 fee per 30-minute session</b>, billed at the next lesson. We appreciate your understanding—late cancellations prevent us from offering the time to other families.</div>
            </div>
            <p style="font-size:13px;color:#7a857e;margin:16px 0 0 0;">Within 24 hours? Text ${coachName} directly.</p>
          </div>
        </div></body></html>`;
      const text = `${coachName} — ${profile.playerName}'s lesson${expanded.length === 1 ? "" : "s"} confirmed:\n${sessionLines}\n\nA calendar file (.ics) is attached for your records.\n\nManage your appointments: ${manageUrl}\nTo change or cancel, please use the link above (sign in with the email you booked with: ${profile.email || "your booking email"}). Changes are accepted up to 24 hours before the scheduled session.\n\nCancellation policy: Cancellations or no-shows within 24 hours of the scheduled session are subject to a $30 fee per 30-minute session, billed at the next lesson.`;
      sendEmail({
        to: profile.email,
        subject: `Booking confirmed: ${profile.playerName} — ${expanded.length} session${expanded.length === 1 ? "" : "s"}`,
        html, text,
        attachments: [{ filename: `lessons-${bookingGroup.slice(0, 8)}.ics`, content: ics }],
      }).catch(e => console.error("parent email send error:", e));
    }
    if ((channel === "sms" || channel === "both") && profile.phone) {
      const smsBody = `${coachName}: ${profile.playerName}'s lesson${expanded.length === 1 ? "" : "s"} confirmed.\n${sessionLines}\nManage: ${manageUrl}\n\nCancellations within 24 hrs are subject to a $30/session fee. Reply STOP to opt out.`;
      sendSms(profile.phone, smsBody).catch(e => console.error("sms confirmation error:", e));
    }

    res.json({
      ok: true, bookingGroup, bookings: expanded, ics,
      coach: { name: coachName, textPhone: getSetting("coachPhone") },
      manageUrl,
    });
  });

  // List bookings (admin)
  app.get("/api/bookings", requireAdmin, (_req, res) => {
    const rows = storage.getBookings().map(b => storage.expandBooking(b));
    res.json({ bookings: rows });
  });

  // List bookings for a profile (self-service lookup by phone)
  app.get("/api/my-bookings/:phone", (req, res) => {
    const profile = storage.getProfileByPhone(req.params.phone);
    if (!profile) return res.json({ profile: null, bookings: [] });
    const rows = storage.getBookingsForProfile(profile.id).map(b => storage.expandBooking(b));
    rows.sort((a, b) => a.start.localeCompare(b.start));
    res.json({ profile, bookings: rows });
  });

  // List bookings for a profile (self-service lookup by EMAIL)
  app.get("/api/my-bookings-by-email/:email", (req, res) => {
    const profile = storage.getProfileByEmail(decodeURIComponent(req.params.email));
    if (!profile) return res.json({ profile: null, bookings: [] });
    const rows = storage.getBookingsForProfile(profile.id).map(b => storage.expandBooking(b));
    rows.sort((a, b) => a.start.localeCompare(b.start));
    res.json({ profile, bookings: rows });
  });

  // Self-service profile update — requires matching email or phone (acts as proof of ownership)
  app.patch("/api/profile/:id", (req, res) => {
    const id = Number(req.params.id);
    const existing = storage.getProfileById(id);
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
      const collides = storage.getProfileByPhone(patch.phone);
      if (collides && collides.id !== id) {
        return res.status(409).json({ error: "That phone number is already used by another account." });
      }
    }
    const updated = storage.updateProfile(id, patch);
    res.json(updated);
  });

  // Cancel single booking (customer or admin)
  app.delete("/api/bookings/:id", (req, res) => {
    const id = Number(req.params.id);
    const isAdmin = String(req.query.admin || "") === "1";
    const b = storage.getBookingById(id);
    if (!b) return res.status(404).json({ error: "Not found" });
    if (!isAdmin && isWithin24h(b.start)) {
      return res.status(400).json({ error: "Within 24 hours — please contact the coach to cancel." });
    }
    // Capture profile/details before delete so we can email
    const profile = storage.getProfileById(b.profileId);
    cancelRemindersForBooking(id);
    storage.deleteBooking(id);

    // Fire-and-forget notifications
    const coachName = getSetting("coachName") || "Coach Skinner";
    const coachEmail = getSetting("coachEmail");
    const manageUrl = (process.env.PUBLIC_SITE_URL || getSetting("publicSiteUrl") || "").replace(/\/$/, "") + "/#/my-appointments";
    const dateLong = formatDateLong(isoDate(b.start));
    const timeStr = formatTime(b.start.split("T")[1]);
    const whoCancelled = isAdmin ? coachName : (profile?.parentName || "The parent");

    if (coachEmail && !isAdmin && profile) {
      sendEmail({
        to: coachEmail,
        subject: `Booking CANCELLED: ${profile.playerName} — ${dateLong} ${timeStr}`,
        text: `${profile.parentName} cancelled a lesson.\n\nPlayer: ${profile.playerName}\nParent: ${profile.parentName}\nPhone: ${profile.phone}\nEmail: ${profile.email}\n\nWas scheduled: ${dateLong} at ${timeStr}\n\nThe slot is now open again.`,
        html: `<p><b>${profile.parentName}</b> cancelled a lesson.</p><ul><li><b>Player:</b> ${profile.playerName}</li><li><b>Parent:</b> ${profile.parentName}</li><li><b>Phone:</b> ${profile.phone}</li><li><b>Email:</b> ${profile.email}</li></ul><p><b>Was scheduled:</b> ${dateLong} at ${timeStr}</p><p>The slot is now open again.</p>`,
      }).catch(e => console.error("coach cancel email error:", e));
    }

    if (profile && profile.email) {
      sendEmail({
        to: profile.email,
        subject: `Cancelled: ${profile.playerName}'s lesson — ${dateLong}`,
        text: `${coachName} — your lesson has been cancelled.\n\nPlayer: ${profile.playerName}\nWas scheduled: ${dateLong} at ${timeStr}\nCancelled by: ${whoCancelled}\n\nWant to rebook? ${manageUrl}`,
        html: `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f1a14;"><div style="max-width:560px;margin:0 auto;padding:24px 16px;"><div style="background:#ffffff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.06);"><div style="font-size:20px;font-weight:600;margin-bottom:12px;color:#1f5a37;">${coachName} · Softball Lessons</div><p style="font-size:16px;margin:0 0 12px 0;">This is a confirmation that <b>${profile.playerName}'s</b> lesson has been cancelled.</p><div style="background:#fff4f4;border-left:4px solid #c0392b;padding:12px 16px;border-radius:6px;margin:12px 0;"><div style="font-weight:600;font-size:14px;margin-bottom:4px;">Cancelled session</div><div style="font-size:15px;line-height:1.5;">${dateLong} at ${timeStr}</div><div style="font-size:13px;color:#7a857e;margin-top:6px;">Cancelled by ${whoCancelled}</div></div><div style="text-align:center;margin:24px 0;"><a href="${manageUrl}" style="display:inline-block;background:#1f5a37;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:16px;">Book another session</a></div></div></div></body></html>`,
      }).catch(e => console.error("parent cancel email error:", e));
    }

    res.json({ ok: true });
  });

  // Reschedule single booking
  app.patch("/api/bookings/:id", (req, res) => {
    const id = Number(req.params.id);
    const newStart = String(req.body?.newStart || "");
    const isAdmin = String(req.query.admin || "") === "1";
    const b = storage.getBookingById(id);
    if (!b) return res.status(404).json({ error: "Not found" });
    if (!isAdmin && isWithin24h(b.start)) {
      return res.status(400).json({ error: "Within 24 hours — please contact the coach to reschedule." });
    }
    if (!isAdmin && isWithin24h(newStart)) {
      return res.status(400).json({ error: "New time must be at least 24 hours from now." });
    }
    if (!isAdmin && isBeyondMaxWindow(newStart)) {
      return res.status(400).json({ error: `New time must be within ${MAX_BOOKING_DAYS} days.` });
    }
    // collision
    const existing = storage.getBookingsByStarts([newStart]).filter(x => x.id !== id);
    if (existing.length) return res.status(409).json({ error: "That time is already booked." });
    // ensure newStart is a valid available slot
    const validSlots = new Set(slotsForDate(isoDate(newStart)));
    if (!validSlots.has(newStart)) return res.status(400).json({ error: "Not an open time slot." });
    const oldStart = b.start;
    storage.updateBookingStart(id, newStart);
    const profile = storage.getProfileById(b.profileId);
    if (profile) rescheduleRemindersForBooking(id, newStart, profile.phone, profile.playerName, profile.email);

    // Fire-and-forget notifications
    const coachName = getSetting("coachName") || "Coach Skinner";
    const coachEmail = getSetting("coachEmail");
    const manageUrl = (process.env.PUBLIC_SITE_URL || getSetting("publicSiteUrl") || "").replace(/\/$/, "") + "/#/my-appointments";
    const oldDateLong = formatDateLong(isoDate(oldStart));
    const oldTime = formatTime(oldStart.split("T")[1]);
    const newDateLong = formatDateLong(isoDate(newStart));
    const newTime = formatTime(newStart.split("T")[1]);
    const whoChanged = isAdmin ? coachName : (profile?.parentName || "The parent");

    if (coachEmail && !isAdmin && profile) {
      sendEmail({
        to: coachEmail,
        subject: `Booking RESCHEDULED: ${profile.playerName} — now ${newDateLong} ${newTime}`,
        text: `${profile.parentName} rescheduled a lesson.\n\nPlayer: ${profile.playerName}\nParent: ${profile.parentName}\nPhone: ${profile.phone}\nEmail: ${profile.email}\n\nOld: ${oldDateLong} at ${oldTime}\nNew: ${newDateLong} at ${newTime}`,
        html: `<p><b>${profile.parentName}</b> rescheduled a lesson.</p><ul><li><b>Player:</b> ${profile.playerName}</li><li><b>Parent:</b> ${profile.parentName}</li><li><b>Phone:</b> ${profile.phone}</li><li><b>Email:</b> ${profile.email}</li></ul><p><b>Old:</b> ${oldDateLong} at ${oldTime}<br><b>New:</b> ${newDateLong} at ${newTime}</p>`,
      }).catch(e => console.error("coach reschedule email error:", e));
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
  app.get("/api/coach", (_req, res) => {
    res.json({ name: getSetting("coachName"), textPhone: getSetting("coachPhone") });
  });

  // Settings (admin)
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
    try {
      const id = Number(req.params.id);
      const profile = storage.getProfileById(id);
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
      const updated = storage.updateProfile(id, { photoPath: publicPath });
      res.json({ ok: true, photoPath: publicPath, profile: updated });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || "Upload failed" });
    }
  });

  // Delete a profile photo. Admin OR customer with matching proofEmail.
  app.delete("/api/profile/:id/photo", (req, res) => {
    const id = Number(req.params.id);
    const profile = storage.getProfileById(id);
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
    const updated = storage.updateProfile(id, { photoPath: "" });
    res.json({ ok: true, profile: updated });
  });

  // ===== Coaching notes thread =====
  // List notes for a profile. Admin OR customer with matching proofEmail.
  app.get("/api/notes/:profileId", (req, res) => {
    const profileId = Number(req.params.profileId);
    const profile = storage.getProfileById(profileId);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    if (!isAdminReq(req)) {
      const proof = String(req.query.proofEmail || "");
      if (!matchesProofEmail(profile.email, proof)) {
        return res.status(403).json({ error: "Verification failed." });
      }
    }
    res.json({ notes: storage.getNotesForProfile(profileId) });
  });

  // Static file serving for note attachments. Path tokens are unguessable.
  app.use("/uploads/notes", express.static(NOTES_DIR, {
    setHeaders: (res) => { res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); },
  }));

  // Post a note. Admin posts as "coach"; customer (with proofEmail) posts as "parent".
  // Accepts multipart/form-data with optional `file` (image/video) or `mediaUrl` (link).
  // Sends an email alert to the OTHER party.
  app.post("/api/notes/:profileId", noteUpload.single("file"), async (req, res) => {
    const profileId = Number(req.params.profileId);
    const profile = storage.getProfileById(profileId);
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

    const note = storage.addNote({ profileId, author, text, mediaType, mediaPath, mediaUrl } as any);

    // Fire-and-forget email alert to the OTHER party
    const coachName = getSetting("coachName") || "Coach Skinner";
    const coachEmail = getSetting("coachEmail");
    const manageUrl = (process.env.PUBLIC_SITE_URL || getSetting("publicSiteUrl") || "").replace(/\/$/, "") + "/#/my-appointments";
    const brand = "#1f5a37";
    const safeText = text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
    const playerLabel = profile.playerName || profile.parentName || "player";

    (async () => {
      try {
        if (author === "coach" && profile.email) {
          // Notify the parent
          await sendEmail({
            to: profile.email,
            subject: `New note from ${coachName} about ${playerLabel}`,
            text: `${coachName} posted a new note in ${playerLabel}'s coaching thread:\n\n${text}\n\nReply at: ${manageUrl}`,
            html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
              <h2 style="color:${brand};margin:0 0 8px">New note from ${coachName}</h2>
              <p style="margin:0 0 16px;color:#555">About <strong>${playerLabel}</strong></p>
              <div style="background:#f7f8f6;border-left:4px solid ${brand};padding:14px 16px;border-radius:6px;white-space:pre-wrap">${safeText}</div>
              <p style="margin:20px 0 0"><a href="${manageUrl}" style="background:${brand};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">Reply to ${coachName}</a></p>
              <p style="margin:24px 0 0;color:#888;font-size:13px">You're receiving this because ${coachName} posted a coaching note for ${playerLabel}.</p>
            </div>`,
          });
        } else if (author === "parent" && coachEmail) {
          // Notify the coach
          await sendEmail({
            to: coachEmail,
            subject: `New note from ${profile.parentName || "a parent"} about ${playerLabel}`,
            text: `${profile.parentName || "A parent"} posted a new note about ${playerLabel}:\n\n${text}\n\nReply at: ${manageUrl}`,
            html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
              <h2 style="color:${brand};margin:0 0 8px">New note from ${profile.parentName || "a parent"}</h2>
              <p style="margin:0 0 16px;color:#555">About <strong>${playerLabel}</strong></p>
              <div style="background:#f7f8f6;border-left:4px solid ${brand};padding:14px 16px;border-radius:6px;white-space:pre-wrap">${safeText}</div>
              <p style="margin:20px 0 0"><a href="${manageUrl}" style="background:${brand};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">Open admin</a></p>
            </div>`,
          });
        }
      } catch (e) { console.error("note email failed:", e); }
    })();

    res.json({ ok: true, note });
  });

  // Delete a note. Admin only (simplest; matches scope).
  app.delete("/api/notes/:noteId", requireAdmin, (req, res) => {
    const id = Number(req.params.noteId);
    const existing = storage.getNoteById(id);
    if (existing?.mediaPath) {
      try { fs.unlinkSync(path.join(NOTES_DIR, existing.mediaPath)); } catch {}
    }
    storage.deleteNote(id);
    res.json({ ok: true });
  });

  // Admin: list all profiles with booking stats
  app.get("/api/admin/profiles", requireAdmin, (_req, res) => {
    const all = storage.getAllProfiles();
    const now = new Date().toISOString();
    const out = all.map((p) => {
      const bks = storage.getBookingsForProfile(p.id);
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
    const id = Number(req.params.id);
    const profile = storage.getProfileById(id);
    if (!profile) return res.status(404).json({ error: "Not found" });
    const bks = storage.getBookingsForProfile(id);
    for (const b of bks) {
      try { cancelRemindersForBooking(b.id); } catch {}
      storage.deleteBooking(b.id);
    }
    const notes = storage.getNotesForProfile(id);
    for (const n of notes) storage.deleteNote(n.id);
    if (profile.photoPath) {
      const filename = profile.photoPath.replace(/^\/uploads\/photos\//, "");
      try { fs.unlinkSync(path.join(PHOTO_DIR, filename)); } catch {}
    }
    storage.deleteProfile(id);
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
    const proof = String(req.query.proofEmail || "").trim().toLowerCase();
    if (!isAdminReq(req)) {
      if (!proof) return res.status(401).json({ error: "Sign up or sign in to view resources." });
      const prof = storage.getProfileByEmail(proof);
      if (!prof) return res.status(403).json({ error: "We couldn't find a profile with that email. Book your first lesson to get access." });
    }
    const list = storage.getResources();
    res.json({ resources: list, categories: RESOURCE_CATEGORIES });
  });

  // Admin: create a resource (link, or upload)
  app.post("/api/admin/resources", requireAdmin, resourceUpload.single("file"), (req, res) => {
    try {
      const body = req.body || {};
      const type = String(body.type || "");
      const category = String(body.category || "general");
      const title = String(body.title || "").trim();
      const description = String(body.description || "").trim();
      const urlIn = String(body.url || "").trim();
      if (!title) return res.status(400).json({ error: "Title is required" });
      if (!["pdf", "link", "image"].includes(type)) return res.status(400).json({ error: "Invalid type" });
      const validCats = RESOURCE_CATEGORIES.map(c => c.id);
      if (!validCats.includes(category as any)) return res.status(400).json({ error: "Invalid category" });

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
      const r = storage.createResource(parsed);
      res.json({ resource: r });
    } catch (e: any) {
      // Clean up uploaded file if validation failed
      if (req.file) { try { fs.unlinkSync(path.join(RESOURCE_DIR, req.file.filename)); } catch {} }
      res.status(400).json({ error: e?.message || "Couldn't create resource" });
    }
  });

  app.delete("/api/admin/resources/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const r = storage.getResourceById(id);
    if (!r) return res.status(404).json({ error: "Not found" });
    if (r.filePath) {
      try { fs.unlinkSync(path.join(RESOURCE_DIR, r.filePath)); } catch {}
    }
    storage.deleteResource(id);
    res.json({ ok: true });
  });

  // ===== Admin team management =====
  app.get("/api/admin/team", requireAdmin, (_req, res) => {
    res.json({ admins: listAdminUsers() });
  });

  app.post("/api/admin/team", requireAdmin, (req, res) => {
    try {
      const phone = String(req.body?.phone || "");
      const name = String(req.body?.name || "");
      const password = String(req.body?.password || "");
      const user = addAdminUser({ phone, name, password });
      res.json({ admin: user });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || "Couldn't add admin" });
    }
  });

  app.delete("/api/admin/team/:id", requireAdmin, (req, res) => {
    try {
      const id = Number(req.params.id);
      deleteAdminUser(id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || "Couldn't remove admin" });
    }
  });

  return httpServer;
}
