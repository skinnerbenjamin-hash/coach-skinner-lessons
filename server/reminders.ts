// Reminder queue. Reminders are scheduled when a booking is created
// (5 days and 2 days before the appointment, at 9:00 AM local) and processed by
// a background interval. Channel (email/sms/both) is decided at SEND TIME based
// on the current 'reminderChannel' setting — so toggling the setting in admin
// affects future sends of already-queued reminders too.

import Database from "better-sqlite3";
import { getSetting } from "./settings";
import { sendEmail } from "./settings";

const sqlite = new Database(process.env.DB_PATH || "data.db");
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    send_at INTEGER NOT NULL,
    kind TEXT NOT NULL,                 -- '5day' | '2day'
    phone TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | cancelled
    sent_at INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS reminders_send_at ON reminders(send_at, status);
  CREATE INDEX IF NOT EXISTS reminders_booking ON reminders(booking_id);
`);

// Migration: add email + subject columns for email delivery.
try {
  const cols = sqlite.prepare(`PRAGMA table_info(reminders)`).all() as { name: string }[];
  if (!cols.some(c => c.name === "email")) sqlite.exec(`ALTER TABLE reminders ADD COLUMN email TEXT NOT NULL DEFAULT ''`);
  if (!cols.some(c => c.name === "subject")) sqlite.exec(`ALTER TABLE reminders ADD COLUMN subject TEXT NOT NULL DEFAULT ''`);
} catch (e) { console.error("reminders migration failed:", e); }

export type Reminder = {
  id: number;
  bookingId: number;
  sendAt: number;
  kind: "5day" | "2day";
  phone: string;
  email: string;
  subject: string;
  message: string;
  status: "pending" | "sent" | "failed" | "cancelled";
  sentAt: number | null;
  error: string | null;
};

function rowToReminder(r: any): Reminder {
  return {
    id: r.id, bookingId: r.booking_id, sendAt: r.send_at, kind: r.kind,
    phone: r.phone, email: r.email ?? "", subject: r.subject ?? "",
    message: r.message, status: r.status,
    sentAt: r.sent_at, error: r.error,
  };
}

function nineAmLocal(dateStr: string): number {
  // dateStr "YYYY-MM-DD" — 9:00 AM in the server's local time
  const d = new Date(`${dateStr}T09:00:00`);
  return d.getTime();
}
function daysBefore(iso: string, days: number): string {
  const d = new Date(iso + ":00");
  d.setDate(d.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function formatTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${String(m).padStart(2, "0")} ${period}`;
}
function formatDateLong(d: string) {
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric",
  });
}

export function scheduleRemindersForBooking(
  bookingId: number,
  startIso: string,            // "YYYY-MM-DDTHH:MM"
  phone: string,
  playerName: string,
  email: string = "",
) {
  const date = startIso.split("T")[0];
  const time = formatTime(startIso.split("T")[1]);
  const summary = `${formatDateLong(date)} at ${time}`;

  const coachName = getSetting("coachName") || "Coach";
  const items: { kind: "5day" | "2day"; days: number; subject: string; msg: string }[] = [
    { kind: "5day", days: 5,
      subject: `Reminder: ${playerName}'s lesson on ${formatDateLong(date)}`,
      msg: `Reminder from ${coachName}: ${playerName}'s lesson is coming up on ${summary}.` },
    { kind: "2day", days: 2,
      subject: `In 2 days: ${playerName}'s lesson on ${formatDateLong(date)}`,
      msg: `Heads up — ${playerName}'s lesson with ${coachName} is in 2 days on ${summary}. See you then.` },
  ];

  const insert = sqlite.prepare(
    `INSERT INTO reminders (booking_id, send_at, kind, phone, email, subject, message, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  );
  for (const it of items) {
    const sendDate = daysBefore(startIso, it.days);
    const sendAt = nineAmLocal(sendDate);
    // skip if already in the past
    if (sendAt < Date.now()) continue;
    insert.run(bookingId, sendAt, it.kind, phone, email, it.subject, it.msg);
  }
}

export function cancelRemindersForBooking(bookingId: number) {
  sqlite.prepare(
    `UPDATE reminders SET status='cancelled' WHERE booking_id=? AND status='pending'`
  ).run(bookingId);
}

export function rescheduleRemindersForBooking(
  bookingId: number, newStartIso: string, phone: string, playerName: string, email: string = "",
) {
  cancelRemindersForBooking(bookingId);
  scheduleRemindersForBooking(bookingId, newStartIso, phone, playerName, email);
}

export function listReminders(opts?: { bookingId?: number; limit?: number }) {
  if (opts?.bookingId !== undefined) {
    const rows = sqlite.prepare(
      `SELECT * FROM reminders WHERE booking_id=? ORDER BY send_at ASC`
    ).all(opts.bookingId);
    return rows.map(rowToReminder);
  }
  const rows = sqlite.prepare(
    `SELECT * FROM reminders ORDER BY send_at DESC LIMIT ?`
  ).all(opts?.limit ?? 100);
  return rows.map(rowToReminder);
}

// --- SMS adapter ---
// Reads Twilio credentials from settings (Admin → Settings). If any are missing,
// runs in dry-run mode (logs the message).
export async function sendSms(phone: string, message: string): Promise<{ ok: true; dryRun?: boolean } | { ok: false; error: string }> {
  const sid = getSetting("twilioAccountSid") || process.env.TWILIO_ACCOUNT_SID || "";
  const tok = getSetting("twilioAuthToken") || process.env.TWILIO_AUTH_TOKEN || "";
  const from = getSetting("twilioFromPhone") || process.env.TWILIO_FROM || "";
  if (sid && tok && from) {
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
      const toFormatted = phone.startsWith("+") ? phone : `+1${phone}`;
      const body = new URLSearchParams({ From: from, To: toFormatted, Body: message });
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        // Twilio returns JSON; try to extract a friendlier message
        let friendly = `Twilio ${resp.status}`;
        try {
          const j = JSON.parse(txt);
          if (j?.message) friendly = `Twilio ${resp.status}: ${j.message}`;
        } catch { friendly = `Twilio ${resp.status}: ${txt.slice(0, 200)}`; }
        return { ok: false, error: friendly };
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
  // No credentials yet — log as if sent (dry-run)
  console.log(`[sms-dry-run] -> ${phone}: ${message}`);
  return { ok: true, dryRun: true };
}

// Renders a friendly HTML reminder email with a big Manage button + 24h-rule copy.
function renderReminderHtml(opts: { greeting: string; bodyText: string; manageUrl: string; cancelDeadline?: string }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f1a14;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="background:#ffffff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
      <div style="font-size:20px;font-weight:600;margin-bottom:12px;color:#1f5a37;">Coach Skinner · Softball Lessons</div>
      <p style="margin:0 0 16px 0;font-size:16px;line-height:1.5;">${opts.greeting}</p>
      <p style="margin:0 0 24px 0;font-size:16px;line-height:1.5;">${opts.bodyText}</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${opts.manageUrl}" style="display:inline-block;background:#1f5a37;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:16px;">Manage your appointments</a>
      </div>
      <p style="margin:0 0 8px 0;font-size:14px;line-height:1.5;color:#525f57;">
        Need to <b>cancel or reschedule</b>? You can do it yourself anytime up to
        <b>24 hours before</b> your session.${opts.cancelDeadline ? ` For this session that's by <b>${opts.cancelDeadline}</b>.` : ""}
        Just open the link above and enter the phone number you booked with.
      </p>
      <p style="margin:16px 0 0 0;font-size:13px;color:#7a857e;">Within 24 hours? Text Coach Skinner directly.</p>
    </div>
    <div style="text-align:center;font-size:12px;color:#7a857e;margin-top:12px;">Coach Skinner Lessons</div>
  </div>
</body></html>`;
}

function formatDeadline(startIso: string): string {
  // 24 hours before the session, formatted in local time
  const d = new Date(startIso + ":00");
  d.setHours(d.getHours() - 24);
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function sendReminderRow(r: any): Promise<{ ok: true; dryRun?: boolean } | { ok: false; error: string }> {
  const channel = (getSetting("reminderChannel") || "email").toLowerCase();
  const manageUrl = (getSetting("publicSiteUrl") || "").replace(/\/$/, "") + "/#/my-appointments";

  // Look up the booking to compute the 24-hour deadline copy.
  const bookingRow = sqlite.prepare(`SELECT start FROM bookings WHERE id=?`).get(r.booking_id) as { start?: string } | undefined;
  const deadline = bookingRow?.start ? formatDeadline(bookingRow.start) : undefined;

  const wantEmail = channel === "email" || channel === "both";
  const wantSms = channel === "sms" || channel === "both";

  const emailAddr = r.email || "";
  const phone = r.phone || "";

  let emailResult: { ok: true; dryRun?: boolean } | { ok: false; error: string } | null = null;
  let smsResult: { ok: true; dryRun?: boolean } | { ok: false; error: string } | null = null;

  if (wantEmail && emailAddr) {
    const html = renderReminderHtml({
      greeting: `Hi from Coach Skinner,`,
      bodyText: r.message,
      manageUrl,
      cancelDeadline: deadline,
    });
    const text = `${r.message}\n\nManage your appointments: ${manageUrl}\nNeed to cancel or reschedule? You can do it yourself anytime up to 24 hours before your session${deadline ? ` (by ${deadline})` : ""}. Just open the link and enter the phone number you booked with.`;
    emailResult = await sendEmail({ to: emailAddr, subject: r.subject || "Lesson reminder", html, text });
  }
  if (wantSms && phone) {
    smsResult = await sendSms(phone, r.message);
  }
  // Success if at least one configured channel succeeded.
  const results = [emailResult, smsResult].filter(Boolean) as Array<{ ok: boolean; error?: string }>;
  if (!results.length) {
    // Nothing to send (e.g., channel=email but no email address). Treat as dry-run success so we don't retry forever.
    return { ok: true, dryRun: true };
  }
  if (results.some(r => r.ok)) return { ok: true };
  return { ok: false, error: results.map(r => (r as any).error).filter(Boolean).join("; ") };
}

async function processDue() {
  const due = sqlite.prepare(
    `SELECT * FROM reminders WHERE status='pending' AND send_at <= ? LIMIT 50`
  ).all(Date.now());
  for (const r of due) {
    const result = await sendReminderRow(r);
    if (result.ok) {
      sqlite.prepare(`UPDATE reminders SET status='sent', sent_at=? WHERE id=?`).run(Date.now(), (r as any).id);
    } else {
      sqlite.prepare(`UPDATE reminders SET status='failed', error=? WHERE id=?`).run(result.error, (r as any).id);
    }
  }
}

let started = false;
export function startReminderLoop() {
  if (started) return;
  started = true;
  // run once shortly after boot, then every 10 minutes
  setTimeout(() => { processDue().catch(() => {}); }, 5_000);
  setInterval(() => { processDue().catch(() => {}); }, 10 * 60 * 1000);
}
