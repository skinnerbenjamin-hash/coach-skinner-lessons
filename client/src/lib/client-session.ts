// Lightweight client-side "remember me" for booking page visitors.
//
// We don't have a real auth session for parents/clients (they identify
// themselves with email when they look up bookings or resources). To keep them
// from typing their email on every page, we cache the last email they used in
// localStorage and rehydrate it on every page that takes an email lookup.
//
// The same key has been used by MyAppointments + Resources for a while
// ("csb-last-email" — legacy "csb" stands for the original Coach Skinner
// Booking name). Centralising read/write here so Book.tsx can join in too and
// future pages stay consistent.

const KEY = "csb-last-email";

export function getRememberedEmail(): string {
  if (typeof window === "undefined") return "";
  try {
    return (window.localStorage.getItem(KEY) || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

export function rememberEmail(email: string): void {
  if (typeof window === "undefined") return;
  const v = (email || "").trim().toLowerCase();
  if (!v) return;
  try {
    window.localStorage.setItem(KEY, v);
  } catch {
    // localStorage can throw in private-mode Safari etc. Swallow — the worst
    // case is the user has to retype their email next time.
  }
}

export function forgetEmail(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {}
}
