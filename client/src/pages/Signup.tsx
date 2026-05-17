// Self-serve signup page for LessonSpot.
//
// One-page form: business name, subdomain (live availability check), email,
// phone, password, sport.  On submit, POSTs to /api/signup.  On success we
// show a "go to your admin" CTA pointing at <slug>.lessonspot.app/admin.
//
// In local dev (no subdomain available) we stay on the same host and let the
// fresh session cookie carry the new tenant id.

import { useEffect, useRef, useState } from "react";

// Same trick used elsewhere in the app: deploy_website rewrites __PORT_5000__
// to the proxied path in prod.  In dev it stays as the literal string and we
// treat that as a same-origin request.
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Check, Loader2, X } from "lucide-react";

type SlugStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok" }
  | { state: "bad"; reason: string };

const SPORTS = [
  { value: "softball", label: "Softball" },
  { value: "baseball", label: "Baseball" },
  { value: "tennis", label: "Tennis" },
  { value: "golf", label: "Golf" },
  { value: "piano", label: "Piano" },
  { value: "guitar", label: "Guitar" },
  { value: "martial_arts", label: "Martial Arts" },
  { value: "fitness", label: "Fitness" },
  { value: "tutoring", label: "Tutoring" },
  { value: "other", label: "Other" },
];

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

export default function Signup() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [sport, setSport] = useState("softball");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-field errors so the user can SEE why the form is invalid instead of
  // just staring at a disabled button.  We populate this in handleSubmit's
  // pre-flight check, not on every keystroke -- that would be too noisy.
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string; slug?: string; email?: string; phone?: string;
    password?: string; confirmPassword?: string;
  }>({});
  const [done, setDone] = useState<{ slug: string; adminUrl: string; trialEndsAt: number } | null>(null);
  const [slugStatus, setSlugStatus] = useState<SlugStatus>({ state: "idle" });

  // Auto-derive slug from name until the user edits the slug field themselves.
  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name));
  }, [name, slugTouched]);

  // Live slug availability check, debounced.  We re-run whenever the slug
  // string changes, with 350ms idle delay.
  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!slug) { setSlugStatus({ state: "idle" }); return; }
    if (slug.length < 3) {
      setSlugStatus({ state: "bad", reason: "At least 3 characters" });
      return;
    }
    setSlugStatus({ state: "checking" });
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/signup/check-slug`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        });
        const data = await r.json();
        if (data.available) setSlugStatus({ state: "ok" });
        else setSlugStatus({ state: "bad", reason: data.reason || "Unavailable" });
      } catch {
        setSlugStatus({ state: "bad", reason: "Could not check availability" });
      }
    }, 350);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [slug]);

  // Validate each field and return an errors object.  Empty object means OK.
  function validate(): typeof fieldErrors {
    const errs: typeof fieldErrors = {};
    if (name.trim().length < 2) errs.name = "Enter your business name";
    if (slugStatus.state !== "ok") {
      errs.slug = slugStatus.state === "bad"
        ? slugStatus.reason
        : "Pick a subdomain";
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = "Enter a valid email";
    if (phone.replace(/\D/g, "").length < 7) errs.phone = "Enter a valid phone number";
    if (password.length < 8) errs.password = "At least 8 characters";
    if (confirmPassword !== password) errs.confirmPassword = "Passwords don't match";
    return errs;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      setError("Please fix the highlighted fields");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slug, email, phone, password, sport }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setError(data.error || "Could not create the account");
        if (data.field) setFieldErrors({ [data.field]: data.error } as any);
        if (data.field === "slug") setSlugStatus({ state: "bad", reason: data.error });
        setBusy(false);
        return;
      }
      setDone({ slug: data.slug, adminUrl: data.adminUrl, trialEndsAt: data.trialEndsAt });
    } catch (err) {
      setError("Network error — try again");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const trialDate = new Date(done.trialEndsAt).toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric",
    });
    return (
      <main className="container mx-auto max-w-xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">You're in</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p>
              Your booking site is live at{" "}
              <span className="font-semibold">{done.slug}.lessonspot.app</span>.
            </p>
            <p className="text-sm text-muted-foreground">
              Your 14-day free trial runs through <span className="font-medium">{trialDate}</span>.
              No card needed.
            </p>
            <div className="rounded-md bg-muted p-4 text-sm">
              <div className="font-semibold mb-2">Next steps</div>
              <ol className="list-decimal pl-5 space-y-1">
                <li>Open your admin dashboard</li>
                <li>Set your hours, lesson types, and branding</li>
                <li>Share your booking link with families</li>
              </ol>
            </div>
            <Button asChild className="w-full" data-testid="link-admin">
              <a href={done.adminUrl}>Open my admin dashboard</a>
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              Or visit{" "}
              <a className="underline" href={`https://${done.slug}.lessonspot.app/`}>
                {done.slug}.lessonspot.app
              </a>{" "}
              to see your public booking page.
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="container mx-auto max-w-xl px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Start your free trial</CardTitle>
          <p className="text-sm text-muted-foreground">
            Spin up your own booking site in under a minute. 14 days free, no card required.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="signup-name">Business name</Label>
              <Input
                id="signup-name"
                data-testid="input-signup-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Coach Skinner Lessons"
                autoComplete="organization"
              />
              {fieldErrors.name && (
                <p className="text-xs text-red-600 mt-1">{fieldErrors.name}</p>
              )}
            </div>

            <div>
              <Label htmlFor="signup-slug">Your booking URL</Label>
              <div className="flex items-center gap-2 mt-1">
                <div className="relative flex-1">
                  <Input
                    id="signup-slug"
                    data-testid="input-signup-slug"
                    value={slug}
                    onChange={(e) => {
                      setSlugTouched(true);
                      setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                    }}
                    placeholder="your-name"
                    autoComplete="off"
                    className="pr-9"
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2">
                    {slugStatus.state === "checking" && (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    )}
                    {slugStatus.state === "ok" && (
                      <Check className="h-4 w-4 text-emerald-600" />
                    )}
                    {slugStatus.state === "bad" && (
                      <X className="h-4 w-4 text-red-500" />
                    )}
                  </div>
                </div>
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  .lessonspot.app
                </span>
              </div>
              {slugStatus.state === "bad" && (
                <p className="text-xs text-red-600 mt-1" data-testid="text-slug-error">
                  {slugStatus.reason}
                </p>
              )}
              {slugStatus.state === "ok" && (
                <p className="text-xs text-emerald-600 mt-1">Available</p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="signup-email">Email</Label>
                <Input
                  id="signup-email"
                  data-testid="input-signup-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
                {fieldErrors.email && (
                  <p className="text-xs text-red-600 mt-1">{fieldErrors.email}</p>
                )}
              </div>
              <div>
                <Label htmlFor="signup-phone">Phone</Label>
                <Input
                  id="signup-phone"
                  data-testid="input-signup-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="(317) 555-1234"
                  autoComplete="tel"
                />
                {fieldErrors.phone && (
                  <p className="text-xs text-red-600 mt-1">{fieldErrors.phone}</p>
                )}
              </div>
            </div>

            <div>
              <Label htmlFor="signup-password">Password</Label>
              <Input
                id="signup-password"
                data-testid="input-signup-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                placeholder="At least 8 characters"
              />
              {fieldErrors.password && (
                <p className="text-xs text-red-600 mt-1">{fieldErrors.password}</p>
              )}
            </div>

            <div>
              <Label htmlFor="signup-confirm-password">Confirm password</Label>
              <Input
                id="signup-confirm-password"
                data-testid="input-signup-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                placeholder="Type your password again"
              />
              {fieldErrors.confirmPassword && (
                <p className="text-xs text-red-600 mt-1">{fieldErrors.confirmPassword}</p>
              )}
            </div>

            <div>
              <Label htmlFor="signup-sport">What do you teach?</Label>
              <Select value={sport} onValueChange={setSport}>
                <SelectTrigger id="signup-sport" data-testid="select-signup-sport">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SPORTS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {error && (
              <div
                className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
                data-testid="text-signup-error"
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={busy}
              data-testid="button-signup-submit"
            >
              {busy ? "Creating your account…" : "Start free trial"}
            </Button>

            <p className="text-xs text-muted-foreground text-center">
              By signing up you agree to our terms. Trial ends in 14 days — no card required.
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
