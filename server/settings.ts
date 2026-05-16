// Simple key/value settings stored in SQLite.
import Database from "better-sqlite3";

const sqlite = new Database(process.env.DB_PATH || "data.db");
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const DEFAULTS: Record<string, string> = {
  coachName: "Coach Skinner",
  coachPhone: "9079527860",         // for "Text Coach" button
  coachEmail: "skinnerbenjamin@yahoo.com", // where booking emails land
  resendApiKey: "",                 // paste in admin
  resendFromEmail: "Coach Skinner <coach@skinnersoftball.com>", // verified domain: skinnersoftball.com
  twilioAccountSid: "",             // starts with AC...
  twilioAuthToken: "",              // secret
  twilioFromPhone: "",              // your Twilio number, format +15551234567
  reminderChannel: "email",         // 'email' | 'sms' | 'both'
  publicSiteUrl: "https://www.perplexity.ai/computer/a/coach-skinner-lessons-hVQD3RSwQtCJc1Ye9XaAZg", // base URL parents can visit to manage appointments
  waitlistEnabled: "1",            // Phase 2: '1' shows 'Join waitlist' on full slots, '0' hides it
};

export function getSetting(key: string): string {
  const row = sqlite.prepare(`SELECT value FROM settings WHERE key=?`).get(key) as { value: string } | undefined;
  if (row?.value !== undefined) return row.value;
  return DEFAULTS[key] ?? "";
}
export function getAllSettings(): Record<string, string> {
  const rows = sqlite.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
  const out: Record<string, string> = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}
export function setSettings(updates: Record<string, string>) {
  const upsert = sqlite.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  for (const [k, v] of Object.entries(updates)) upsert.run(k, String(v ?? ""));
}

// --- Email send via Resend ---
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: string /* utf-8 string */ }[];
}): Promise<{ ok: boolean; error?: string; dryRun?: boolean }> {
  // Env vars take precedence over DB settings (so Render-managed secrets work without admin config)
  const apiKey = process.env.RESEND_API_KEY || getSetting("resendApiKey");
  const from = process.env.RESEND_FROM || getSetting("resendFromEmail") || DEFAULTS.resendFromEmail;
  if (!apiKey) {
    console.log(`[email-dry-run] to=${opts.to} subject="${opts.subject}"`);
    return { ok: true, dryRun: true };
  }
  try {
    const payload: Record<string, unknown> = {
      from,
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    };
    if (opts.attachments && opts.attachments.length) {
      payload.attachments = opts.attachments.map(a => ({
        filename: a.filename,
        content: Buffer.from(a.content, "utf8").toString("base64"),
      }));
    }
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, error: `Resend ${resp.status}: ${body}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Backwards-compat wrapper for the previous .ics-attached helper.
export async function sendBookingEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  icsContent: string;
  icsFilename: string;
}): Promise<{ ok: boolean; error?: string; dryRun?: boolean }> {
  return sendEmail({
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    attachments: [{ filename: opts.icsFilename, content: opts.icsContent }],
  });
}
