// Pure date/time helpers used across pages. All times are local strings.
export function pad(n: number) { return String(n).padStart(2, "0"); }
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function formatTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${pad(m)} ${period}`;
}
export function formatDateLong(d: string) {
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}
export function formatDateFull(d: string) {
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}
export function formatIsoStartEnd(startIso: string) {
  const time = startIso.split("T")[1];
  const [h, m] = time.split(":").map(Number);
  const endMin = h * 60 + m + 30;
  const endT = `${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}`;
  return `${formatTime(time)} – ${formatTime(endT)}`;
}
export function normalizePhone(p: string) { return (p || "").replace(/\D+/g, ""); }
export function formatPhone(p: string) {
  const d = normalizePhone(p);
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return p;
}
export function isWithin24h(iso: string): boolean {
  const t = new Date(iso + ":00").getTime();
  return t - Date.now() < 24 * 60 * 60 * 1000;
}
export function downloadICS(filename: string, ics: string) {
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}
