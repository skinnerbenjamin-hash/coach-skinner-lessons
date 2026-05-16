import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  addDays, todayISO, formatTime, formatDateLong, formatDateFull,
  formatIsoStartEnd, formatPhone, normalizePhone, downloadICS,
} from "@/lib/scheduling";
import {
  ChevronLeft, ChevronRight, CalendarPlus, MessageSquareText,
  Check, AlertTriangle, X, Camera, Search,
} from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

type SlotsResponse = {
  days: { date: string; slots: { start: string; booked: boolean }[] }[];
};
type GapWarning = {
  date: string; gapStart: string; gapEnd: string; gapMinutes: number;
  message: string; suggestion?: { from: string; to: string; reason: string };
};

type Profile = { id: number; phone: string; email: string; parentName: string; playerName: string; notes: string; photoPath?: string };

type Step = "profile" | "pick" | "review" | "done";

export default function Book() {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>("profile");

  // profile
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [parentName, setParentName] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [notes, setNotes] = useState("");
  const [profileLoaded, setProfileLoaded] = useState<Profile | null>(null);

  // returning user email lookup
  const [lookupEmail, setLookupEmail] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);

  // optional photo upload during signup
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [pendingPhotoPreview, setPendingPhotoPreview] = useState<string | null>(null);
  const [existingPhotoPath, setExistingPhotoPath] = useState<string>("");

  // selections
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [weekStart, setWeekStart] = useState(todayISO());
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);

  // result
  const [confirmation, setConfirmation] = useState<null | {
    bookings: { start: string }[]; ics: string; coachTextPhone: string; coachName: string; manageUrl: string;
  }>(null);

  // fetch availability
  const { data: slotsData, isLoading: slotsLoading } = useQuery<SlotsResponse>({
    queryKey: ["/api/slots", weekStart, weekEnd],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/slots?start=${weekStart}&end=${weekEnd}`);
      return r.json();
    },
  });

  // lookup existing profile when phone is typed
  const lookupProfile = async (p: string) => {
    const digits = normalizePhone(p);
    if (digits.length < 10) return;
    try {
      const r = await fetch(`${API_BASE}/api/profile/${digits}`);
      if (r.ok) {
        const prof: Profile = await r.json();
        setProfileLoaded(prof);
        setParentName(prof.parentName);
        setPlayerName(prof.playerName);
        setNotes(prof.notes || "");
        if (prof.email) setEmail(prof.email);
        if (prof.photoPath) setExistingPhotoPath(prof.photoPath);
      } else {
        setProfileLoaded(null);
      }
    } catch { /* ignore */ }
  };

  // Returning user: look up by email and skip straight to picking times
  const lookupByEmail = async () => {
    const e = lookupEmail.trim();
    if (!e) return;
    setLookupBusy(true);
    setLookupError(null);
    try {
      const r = await fetch(`${API_BASE}/api/my-bookings-by-email/${encodeURIComponent(e)}`);
      if (!r.ok) {
        setLookupError("We couldn't find a profile with that email. Fill out the form below to sign up.");
        return;
      }
      const data = await r.json();
      const prof: Profile = data.profile;
      if (!prof) {
        setLookupError("We couldn't find a profile with that email. Fill out the form below to sign up.");
        return;
      }
      setProfileLoaded(prof);
      setPhone(prof.phone);
      setEmail(prof.email);
      setParentName(prof.parentName);
      setPlayerName(prof.playerName);
      setNotes(prof.notes || "");
      if (prof.photoPath) setExistingPhotoPath(prof.photoPath);
      setStep("pick");
      toast({ title: `Welcome back, ${prof.parentName}`, description: "We loaded your info — pick your times." });
    } catch (err: any) {
      setLookupError("Something went wrong looking that up. Please try again.");
    } finally {
      setLookupBusy(false);
    }
  };

  function handlePhotoFile(f: File | null) {
    setPendingPhoto(f);
    if (pendingPhotoPreview) URL.revokeObjectURL(pendingPhotoPreview);
    setPendingPhotoPreview(f ? URL.createObjectURL(f) : null);
  }

  // gap check
  const [gapWarnings, setGapWarnings] = useState<GapWarning[]>([]);
  const checkGaps = useMutation({
    mutationFn: async (slots: string[]) => {
      const r = await apiRequest("POST", "/api/check-gaps", { slots });
      return (await r.json()).warnings as GapWarning[];
    },
    onSuccess: (warnings) => setGapWarnings(warnings),
  });

  useEffect(() => {
    if (step === "review" && selected.size > 0) {
      checkGaps.mutate(Array.from(selected));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selected]);

  // apply suggested shift
  function applyShift(from: string, to: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.delete(from);
      next.add(to);
      return next;
    });
  }

  // submit
  const checkout = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/bookings", {
        slots: Array.from(selected),
        phone: normalizePhone(phone),
        email: email.trim(),
        parentName, playerName, notes,
      });
      const data = await r.json();
      // After booking creates/updates the profile, upload optional photo if user chose one
      if (pendingPhoto && data?.bookings?.[0]) {
        try {
          const lookupResp = await fetch(`${API_BASE}/api/profile/${normalizePhone(phone)}`);
          if (lookupResp.ok) {
            const prof: Profile = await lookupResp.json();
            const fd = new FormData();
            fd.append("photo", pendingPhoto);
            fd.append("proofEmail", email.trim());
            await fetch(`${API_BASE}/api/profile/${prof.id}/photo`, {
              method: "POST",
              credentials: "include",
              body: fd,
            });
          }
        } catch (err) {
          console.error("photo upload failed:", err);
        }
      }
      return data;
    },
    onSuccess: (resp) => {
      setConfirmation({
        bookings: resp.bookings,
        ics: resp.ics,
        coachTextPhone: resp.coach?.textPhone ?? "",
        coachName: resp.coach?.name ?? "Coach",
        manageUrl: resp.manageUrl ?? "/#/my-appointments",
      });
      setStep("done");
      setPendingPhoto(null);
      if (pendingPhotoPreview) { URL.revokeObjectURL(pendingPhotoPreview); setPendingPhotoPreview(null); }
      queryClient.invalidateQueries({ queryKey: ["/api/slots"] });
    },
    onError: (e: any) => {
      toast({ variant: "destructive", title: "Couldn't book", description: e.message });
    },
  });

  // grouped/sorted selections for review
  const selectedByDate = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of selected) {
      const d = s.split("T")[0];
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(s);
    }
    for (const arr of m.values()) arr.sort();
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [selected]);

  // Simple email format check — server also validates with z.string().email()
  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const validProfile = normalizePhone(phone).length >= 10 && emailLooksValid && parentName.trim() && playerName.trim();

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8">
      <Stepper step={step} />

      {step === "profile" && (
        <>
        {/* Returning user shortcut */}
        <Card className="mt-6 border-primary/40 bg-primary/5">
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-primary" />
              <h2 className="text-base font-semibold">Already registered? Skip the form.</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Enter the email you used last time — we'll look you up and take you straight to picking times.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={lookupEmail}
                onChange={(e) => setLookupEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") lookupByEmail(); }}
                data-testid="input-returning-email"
              />
              <Button
                onClick={lookupByEmail}
                disabled={!lookupEmail.trim() || lookupBusy}
                data-testid="button-returning-lookup"
              >
                {lookupBusy ? "Looking up…" : "Look up"}
              </Button>
            </div>
            {lookupError && (
              <p className="text-xs text-destructive" data-testid="text-lookup-error">{lookupError}</p>
            )}
          </CardContent>
        </Card>

        <Card className="mt-4">
          <CardContent className="p-6 space-y-4">
            <h1 className="text-xl font-semibold">New here? Tell us about the player</h1>
            <p className="text-sm text-muted-foreground">
              We'll save this info so you can look up appointments later, reschedule, or
              book more sessions without re-typing.
            </p>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="phone">Parent phone *</Label>
                <Input
                  id="phone"
                  data-testid="input-phone"
                  inputMode="tel"
                  placeholder="(317) 555-1234"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onBlur={() => lookupProfile(phone)}
                />
                {profileLoaded && (
                  <p className="text-xs text-primary mt-1">
                    Welcome back — we loaded your profile.
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="email">Parent email *</Label>
                <Input
                  id="email"
                  data-testid="input-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  We'll email your confirmation, calendar file, and reminders.
                </p>
              </div>
              <div>
                <Label htmlFor="parent">Parent name *</Label>
                <Input
                  id="parent"
                  data-testid="input-parent-name"
                  placeholder="Jane Skinner"
                  value={parentName}
                  onChange={(e) => setParentName(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="player">Player name *</Label>
                <Input
                  id="player"
                  data-testid="input-player-name"
                  placeholder="Emma Skinner"
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="notes">Focus areas (optional)</Label>
                <Input
                  id="notes"
                  data-testid="input-notes"
                  placeholder="Hitting, pitching, fielding…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>

            {/* Optional player photo */}
            <div className="rounded-lg border border-dashed border-border p-4">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <Avatar className="h-16 w-16">
                    {pendingPhotoPreview ? (
                      <AvatarImage src={pendingPhotoPreview} alt="Player" />
                    ) : existingPhotoPath ? (
                      <AvatarImage src={existingPhotoPath} alt="Player" />
                    ) : null}
                    <AvatarFallback className="bg-muted">
                      <Camera className="h-5 w-5 text-muted-foreground" />
                    </AvatarFallback>
                  </Avatar>
                </div>
                <div className="flex-1">
                  <Label className="text-sm font-medium">Player photo (optional)</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Helps Coach recognize {playerName || "your player"} on lesson day. You can add or change this anytime later.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="cursor-pointer">
                      <input
                        type="file"
                        accept="image/*"
                        capture="user"
                        className="hidden"
                        data-testid="input-signup-photo"
                        onChange={(e) => handlePhotoFile(e.target.files?.[0] ?? null)}
                      />
                      <span className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
                        <Camera className="h-4 w-4" />
                        {pendingPhoto ? "Change photo" : "Add photo"}
                      </span>
                    </label>
                    {pendingPhoto && (
                      <button
                        type="button"
                        onClick={() => handlePhotoFile(null)}
                        className="text-xs text-muted-foreground hover:text-destructive"
                        data-testid="button-clear-signup-photo"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                disabled={!validProfile}
                onClick={() => setStep("pick")}
                data-testid="button-profile-continue"
              >
                Continue
              </Button>
            </div>
          </CardContent>
        </Card>
        </>
      )}

      {step === "pick" && (
        <div className="mt-6 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-xl font-semibold">Pick your sessions</h1>
              <p className="text-sm text-muted-foreground">
                Each session is 30 minutes. Tap any available time to add it.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setWeekStart(addDays(weekStart, -7))}
                disabled={weekStart <= todayISO()}
                data-testid="button-prev-week"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="text-sm font-medium px-2 min-w-44 text-center">
                {formatDateLong(weekStart)} – {formatDateLong(weekEnd)}
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setWeekStart(addDays(weekStart, 7))}
                disabled={addDays(weekStart, 7) > addDays(todayISO(), 30)}
                data-testid="button-next-week"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {slotsLoading && <SkeletonGrid />}

          {!slotsLoading && slotsData && (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {slotsData.days.map(d => (
                <DayCard
                  key={d.date}
                  date={d.date}
                  slots={d.slots}
                  selected={selected}
                  onToggle={(s) => {
                    setSelected(prev => {
                      const next = new Set(prev);
                      next.has(s) ? next.delete(s) : next.add(s);
                      return next;
                    });
                  }}
                />
              ))}
            </div>
          )}

          <Separator />
          <div className="flex items-center justify-between flex-wrap gap-3 sticky bottom-0 bg-background/80 backdrop-blur pt-3 pb-1">
            <div className="text-sm">
              <Badge variant="secondary" data-testid="text-selected-count">
                {selected.size} {selected.size === 1 ? "session" : "sessions"} selected
              </Badge>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setStep("profile")}>
                Back
              </Button>
              <Button
                disabled={selected.size === 0}
                onClick={() => setStep("review")}
                data-testid="button-go-to-review"
              >
                Review & checkout
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="mt-6 space-y-4">
          <h1 className="text-xl font-semibold">Review your booking</h1>

          {gapWarnings.length > 0 && (
            <div className="space-y-3">
              {gapWarnings.map((w, i) => (
                <Alert key={i} className="border-accent/60">
                  <AlertTriangle className="h-4 w-4 text-accent-foreground" />
                  <AlertDescription>
                    <div className="font-medium">{w.message}</div>
                    <div className="text-sm text-muted-foreground mt-1">
                      Coach tries to avoid short orphan gaps. Want to shift one of your
                      slots to close it?
                    </div>
                    {w.suggestion && (
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => applyShift(w.suggestion!.from, w.suggestion!.to)}
                          data-testid={`button-apply-shift-${i}`}
                        >
                          {w.suggestion.reason}
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          Or keep as-is — it's totally fine.
                        </span>
                      </div>
                    )}
                  </AlertDescription>
                </Alert>
              ))}
            </div>
          )}

          <Card>
            <CardContent className="p-6 space-y-3">
              <div className="text-sm text-muted-foreground">Player</div>
              <div className="font-medium" data-testid="text-review-player">
                {playerName} <span className="text-muted-foreground">·</span>{" "}
                <span className="text-muted-foreground">{parentName} · {formatPhone(phone)}</span>
              </div>
              {notes && <div className="text-sm">Focus: {notes}</div>}

              <Separator />

              <div className="space-y-3">
                {selectedByDate.map(([date, slots]) => (
                  <div key={date}>
                    <div className="font-medium">{formatDateFull(date)}</div>
                    <ul className="mt-1 space-y-1">
                      {slots.map(s => (
                        <li key={s} className="flex items-center justify-between text-sm">
                          <span data-testid={`text-review-slot-${s}`}>{formatIsoStartEnd(s)}</span>
                          <button
                            className="text-muted-foreground hover:text-destructive p-1"
                            onClick={() => setSelected(p => { const n = new Set(p); n.delete(s); return n; })}
                            aria-label="Remove"
                            data-testid={`button-remove-${s}`}
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep("pick")}>Back</Button>
            <Button
              onClick={() => checkout.mutate()}
              disabled={selected.size === 0 || checkout.isPending}
              data-testid="button-confirm-booking"
            >
              {checkout.isPending ? "Booking…" : `Confirm ${selected.size} session${selected.size === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && confirmation && (
        <Card className="mt-6">
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center gap-2 text-primary">
              <Check className="h-5 w-5" /> <span className="font-semibold">You're booked.</span>
            </div>
            <p className="text-sm">
              A confirmation email is on its way to <span className="font-medium">{email}</span> with a
              calendar file attached. We'll email reminders 5 days and 2 days before each session.
            </p>
            <ul className="text-sm space-y-1">
              {confirmation.bookings.map((b) => (
                <li key={b.start} data-testid={`text-confirmed-${b.start}`}>
                  • {formatDateLong(b.start.split("T")[0])} — {formatIsoStartEnd(b.start)}
                </li>
              ))}
            </ul>
            <Alert className="border-primary/40 bg-primary/5">
              <AlertDescription>
                <div className="font-semibold text-sm mb-1">Save this link — it's how you cancel or reschedule</div>
                <p className="text-sm leading-relaxed">
                  Go to{" "}
                  <a
                    href={confirmation.manageUrl || "/#/my-appointments"}
                    className="underline font-medium"
                    data-testid="link-manage"
                  >
                    {confirmation.manageUrl ? confirmation.manageUrl.replace(/^https?:\/\//, "") : "this site › My appointments"}
                  </a>{" "}
                  and enter <span className="font-medium whitespace-nowrap">{formatPhone(phone)}</span> any time.
                  You can change or cancel <b>up to 24 hours before</b> a session. Within 24 hours? Text {confirmation.coachName}.
                </p>
              </AlertDescription>
            </Alert>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                variant="default"
                onClick={() => downloadICS("softball-lessons.ics", confirmation.ics)}
                data-testid="button-add-to-calendar"
              >
                <CalendarPlus className="h-4 w-4 mr-2" /> Add to my calendar
              </Button>
              <Button asChild variant="outline">
                <a
                  href="/#/my-appointments"
                  data-testid="link-go-to-my-appointments"
                >
                  View my appointments
                </a>
              </Button>
              {confirmation.coachTextPhone && (
                <Button asChild variant="ghost">
                  <a
                    href={`sms:${confirmation.coachTextPhone}?&body=${encodeURIComponent(
                      `Hi ${confirmation.coachName}, this is ${parentName} confirming ${playerName}'s sessions.`
                    )}`}
                    data-testid="link-text-coach"
                  >
                    <MessageSquareText className="h-4 w-4 mr-2" /> Text {confirmation.coachName}
                  </a>
                </Button>
              )}
            </div>
            <Button
              variant="link"
              className="px-0"
              onClick={() => {
                setSelected(new Set());
                setConfirmation(null);
                setStep("pick");
              }}
            >
              Book another session
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: "profile", label: "Your info" },
    { id: "pick", label: "Pick times" },
    { id: "review", label: "Review" },
    { id: "done", label: "Done" },
  ];
  const idx = steps.findIndex(s => s.id === step);
  return (
    <ol className="flex items-center gap-2 text-xs font-medium">
      {steps.map((s, i) => (
        <li key={s.id} className="flex items-center gap-2">
          <span
            className={
              i <= idx
                ? "h-6 w-6 rounded-full bg-primary text-primary-foreground inline-flex items-center justify-center"
                : "h-6 w-6 rounded-full bg-muted text-muted-foreground inline-flex items-center justify-center"
            }
          >
            {i + 1}
          </span>
          <span className={i === idx ? "text-foreground" : "text-muted-foreground"}>{s.label}</span>
          {i < steps.length - 1 && <span className="text-muted-foreground">›</span>}
        </li>
      ))}
    </ol>
  );
}

function DayCard({
  date, slots, selected, onToggle,
}: {
  date: string; slots: { start: string; booked: boolean }[];
  selected: Set<string>; onToggle: (s: string) => void;
}) {
  const todayDate = todayISO();
  const isPast = date < todayDate;
  return (
    <Card data-testid={`card-day-${date}`}>
      <CardContent className="p-4">
        <div className="flex items-baseline justify-between mb-2">
          <div className="font-semibold">{formatDateLong(date)}</div>
          {isPast && <Badge variant="outline" className="text-xs">Past</Badge>}
          {!isPast && slots.length === 0 && (
            <Badge variant="outline" className="text-xs">Closed</Badge>
          )}
        </div>
        {slots.length === 0 ? (
          <p className="text-xs text-muted-foreground">No sessions available.</p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {slots.map((s) => {
              const isSelected = selected.has(s.start);
              const time = s.start.split("T")[1];
              const disabled = s.booked || isPast;
              return (
                <button
                  key={s.start}
                  disabled={disabled}
                  onClick={() => onToggle(s.start)}
                  data-testid={`button-slot-${s.start}`}
                  className={
                    "text-xs px-2 py-1.5 rounded-md border transition-colors " +
                    (disabled
                      ? "border-border bg-muted/40 text-muted-foreground line-through cursor-not-allowed"
                      : isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover-elevate")
                  }
                >
                  {formatTime(time)}
                </button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: 7 }).map((_, i) => (
        <Card key={i}><CardContent className="p-4">
          <div className="h-4 w-20 bg-muted rounded animate-pulse mb-3" />
          <div className="grid grid-cols-2 gap-1.5">
            {Array.from({ length: 8 }).map((_, j) => (
              <div key={j} className="h-7 bg-muted rounded animate-pulse" />
            ))}
          </div>
        </CardContent></Card>
      ))}
    </div>
  );
}
