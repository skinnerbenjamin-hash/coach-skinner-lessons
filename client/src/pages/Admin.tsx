import { useMemo, useRef, useState } from "react"; 
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useTenantLabels } from "@/hooks/use-tenant";
import { formatDateFull, formatDateLong, formatIsoStartEnd, formatPhone, todayISO } from "@/lib/scheduling";
import { Trash2, LogOut, Eye, EyeOff, Send, Download, Search, FileText, ExternalLink, Image as ImageIcon, Upload, UserPlus, Crown, ShieldCheck, Paperclip, Link as LinkIcon, X, Video, Plus, CalendarPlus, Pencil } from "lucide-react";

type Booking = {
  id: number; start: string; bookingGroup: string; createdAt: number;
  profileId: number;
  parentName: string; playerName: string; phone: string; email: string; notes: string;
  photoPath: string;
};
type CoachingNote = { id: number; profileId: number; author: "coach" | "parent"; text: string; mediaType: "image" | "video" | "link" | null; mediaPath: string | null; mediaUrl: string | null; createdAt: number };

function initialsFor(name: string): string {
  return (name || "?").trim().split(/\s+/).slice(0, 2).map(p => p[0] || "").join("").toUpperCase() || "?";
}
type Availability = { id: number; dayOfWeek: number; startTime: string; endTime: string };
type DateOverride = { id: number; date: string; type: string; startTime: string | null; endTime: string | null };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function Admin() {
  const { data, isLoading } = useQuery<{ authed: boolean }>({ queryKey: ["/api/auth/me"] });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }
  if (!data?.authed) {
    return <AdminLogin />;
  }
  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold">Admin</h1>
        <SignOutButton />
      </div>
      <p className="text-sm text-muted-foreground mb-6">Manage bookings, availability, and reminders.</p>
      <Tabs defaultValue="bookings">
        <TabsList>
          <TabsTrigger value="bookings" data-testid="tab-bookings">Bookings</TabsTrigger>
          <TabsTrigger value="members" data-testid="tab-members">Members</TabsTrigger>
          <TabsTrigger value="resources" data-testid="tab-resources">Resources</TabsTrigger>
          <TabsTrigger value="team" data-testid="tab-team">Team</TabsTrigger>
          <TabsTrigger value="availability" data-testid="tab-availability">Availability</TabsTrigger>
          <TabsTrigger value="overrides" data-testid="tab-overrides">Blackouts</TabsTrigger>
          <TabsTrigger value="reminders" data-testid="tab-reminders">SMS reminders</TabsTrigger>
          <TabsTrigger value="branding" data-testid="tab-branding">Branding</TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="bookings"><BookingsPanel /></TabsContent>
        <TabsContent value="members"><MembersPanel /></TabsContent>
        <TabsContent value="resources"><ResourcesPanel /></TabsContent>
        <TabsContent value="team"><TeamPanel /></TabsContent>
        <TabsContent value="availability"><AvailabilityPanel /></TabsContent>
        <TabsContent value="overrides"><OverridesPanel /></TabsContent>
        <TabsContent value="reminders"><RemindersPanel /></TabsContent>
        <TabsContent value="branding"><BrandingPanel /></TabsContent>
        <TabsContent value="settings"><SettingsPanel /></TabsContent>
      </Tabs>
    </div>
  );
}

function AdminLogin() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const login = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/login", { phone: phone.trim(), password });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
    onError: (e: any) => {
      toast({ title: "Sign-in failed", description: e?.message?.replace(/^\d+:\s*/, "") || "Try again", variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone.trim() || !password) {
      toast({ title: "Missing info", description: "Enter both phone and password.", variant: "destructive" });
      return;
    }
    login.mutate();
  };

  return (
    <div className="mx-auto max-w-md px-4 sm:px-6 py-10">
      <Card>
        <CardContent className="p-6 space-y-4">
          <div>
            <h1 className="text-xl font-semibold">Admin sign in</h1>
            <p className="text-sm text-muted-foreground mt-1">Enter your phone number and password.</p>
          </div>
          <form className="space-y-3" onSubmit={handleSubmit}>
            <div className="space-y-1">
              <Label htmlFor="login-phone">Phone</Label>
              <Input
                id="login-phone" type="tel" inputMode="tel" autoComplete="username"
                value={phone} onChange={e => setPhone(e.target.value)}
                placeholder="9079527860"
                data-testid="input-login-phone"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="login-password">Password</Label>
              <div className="relative">
                <Input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password} onChange={e => setPassword(e.target.value)}
                  className="pr-10"
                  data-testid="input-login-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(s => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  data-testid="button-toggle-password"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <Button
              type="submit" className="w-full"
              disabled={login.isPending}
              data-testid="button-login"
            >
              {login.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function SignOutButton() {
  const qc = useQueryClient();
  const signOut = useMutation({
    mutationFn: async () => { await apiRequest("POST", "/api/auth/logout", {}); },
    onSuccess: () => {
      qc.clear();
      qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
  });
  return (
    <Button variant="ghost" size="sm" onClick={() => signOut.mutate()} data-testid="button-sign-out">
      <LogOut className="h-4 w-4 mr-1" /> Sign out
    </Button>
  );
}

function AddBookingDialog() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const labels = useTenantLabels();
  const [open, setOpen] = useState(false);
  const [memberId, setMemberId] = useState<string>("new");
  const [parentName, setParentName] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [date, setDate] = useState(todayISO());
  const [time, setTime] = useState("16:00");
  const [notes, setNotes] = useState("");

  const { data: membersData } = useQuery<{ profiles: MemberRow[] }>({
    queryKey: ["/api/admin/profiles"],
    enabled: open,
  });
  const members = membersData?.profiles ?? [];

  function pickMember(id: string) {
    setMemberId(id);
    if (id === "new") {
      setParentName(""); setPlayerName(""); setPhone(""); setEmail("");
      return;
    }
    const m = members.find(p => String(p.id) === id);
    if (m) {
      setParentName(m.parentName);
      setPlayerName(m.playerName);
      setPhone(m.phone);
      setEmail(m.email);
    }
  }

  const create = useMutation({
    mutationFn: async () => {
      const slot = `${date}T${time}`;
      const body = {
        slots: [slot],
        phone: phone.trim(),
        email: email.trim(),
        parentName: parentName.trim(),
        playerName: playerName.trim(),
        notes: notes.trim(),
      };
      const r = await apiRequest("POST", "/api/bookings", body);
      const json = await r.json();
      if (!r.ok) throw new Error(json?.error || "Couldn't create booking");
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/bookings"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/profiles"] });
      toast({ title: "Booking added", description: "Confirmation emails were sent to you and the parent." });
      setOpen(false);
      setMemberId("new");
      setParentName(""); setPlayerName(""); setPhone(""); setEmail(""); setNotes("");
    },
    onError: (e: any) => toast({ variant: "destructive", title: "Couldn't book", description: e.message }),
  });

  const valid = parentName.trim() && playerName.trim() && phone.replace(/\D/g, "").length >= 7
    && /@/.test(email) && date && time;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="button-admin-new-booking">
          <CalendarPlus className="h-4 w-4 mr-2" /> New booking
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a booking</DialogTitle>
          <DialogDescription>
            Book a slot on behalf of a player. You and the parent both get the usual confirmation email with the calendar file.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>{labels.attendee}</Label>
            <Select value={memberId} onValueChange={pickMember}>
              <SelectTrigger data-testid="select-admin-booking-member">
                <SelectValue placeholder={`Pick a ${labels.attendee.toLowerCase()} or add new`} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">+ Add new {labels.attendee.toLowerCase()}</SelectItem>
                {members.map(m => (
                  <SelectItem key={m.id} value={String(m.id)}>
                    {m.playerName} ({m.parentName})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="ab-player">{labels.attendee} name</Label>
              <Input id="ab-player" value={playerName} onChange={e => setPlayerName(e.target.value)} data-testid="input-admin-booking-player" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ab-parent">{labels.booker} name</Label>
              <Input id="ab-parent" value={parentName} onChange={e => setParentName(e.target.value)} data-testid="input-admin-booking-parent" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="ab-phone">Phone</Label>
              <Input id="ab-phone" value={phone} onChange={e => setPhone(e.target.value)} data-testid="input-admin-booking-phone" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ab-email">Email</Label>
              <Input id="ab-email" type="email" value={email} onChange={e => setEmail(e.target.value)} data-testid="input-admin-booking-email" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="ab-date">Date</Label>
              <Input id="ab-date" type="date" value={date} onChange={e => setDate(e.target.value)} data-testid="input-admin-booking-date" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ab-time">Time</Label>
              <Input id="ab-time" type="time" step={1800} value={time} onChange={e => setTime(e.target.value)} data-testid="input-admin-booking-time" />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ab-notes">Notes (optional)</Label>
            <Textarea id="ab-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} data-testid="input-admin-booking-notes" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!valid || create.isPending} data-testid="button-admin-booking-submit">
            {create.isPending ? "Booking…" : "Book lesson"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BookingsPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ bookings: Booking[] }>({ queryKey: ["/api/bookings"] });
  const del = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/bookings/${id}?admin=1`); },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/bookings"] }); toast({ title: "Cancelled" }); },
  });
  const [notesProfileId, setNotesProfileId] = useState<number | null>(null);
  function openNotesFor(profileId: number) { setNotesProfileId(profileId); }
  const profileForNotes = notesProfileId
    ? (data?.bookings ?? []).find(b => b.profileId === notesProfileId)
    : null;
  const upcoming = (data?.bookings ?? []).filter(b => b.start >= todayISO() + "T00:00")
    .sort((a, b) => a.start.localeCompare(b.start));
  const past = (data?.bookings ?? []).filter(b => b.start < todayISO() + "T00:00")
    .sort((a, b) => b.start.localeCompare(a.start)).slice(0, 50);

  return (
    <div className="space-y-6 mt-4">
      <div className="flex justify-end">
        <AddBookingDialog />
      </div>
      <Section title={`Upcoming (${upcoming.length})`}>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && upcoming.length === 0 && (
          <p className="text-sm text-muted-foreground">No upcoming bookings.</p>
        )}
        <div className="space-y-2">
          {upcoming.map(b => (
            <div key={b.id} className="border rounded-md p-3 flex items-center justify-between gap-3" data-testid={`row-admin-booking-${b.id}`}>
              <div className="flex items-center gap-3 min-w-0">
                <Avatar className="h-10 w-10 flex-shrink-0">
                  {b.photoPath ? <AvatarImage src={b.photoPath} alt={b.playerName} /> : null}
                  <AvatarFallback className="text-xs">{initialsFor(b.playerName)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="font-medium">
                    {formatDateLong(b.start.split("T")[0])} — {formatIsoStartEnd(b.start)}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    <button
                      type="button"
                      className="font-medium text-foreground underline-offset-2 hover:underline"
                      onClick={() => openNotesFor(b.profileId)}
                      data-testid={`button-open-notes-${b.profileId}`}
                    >
                      {b.playerName}
                    </button>
                    {" "}· {b.parentName} · {formatPhone(b.phone)}
                    {b.notes && <span> · “{b.notes}”</span>}
                  </div>
                </div>
              </div>
              <Button
                variant="ghost" size="sm"
                onClick={() => del.mutate(b.id)}
                data-testid={`button-admin-cancel-${b.id}`}
              >
                <Trash2 className="h-4 w-4 mr-1" /> Cancel
              </Button>
            </div>
          ))}
        </div>
      </Section>

      {past.length > 0 && (
        <Section title="Recent past">
          <div className="space-y-2 opacity-70">
            {past.map(b => (
              <div key={b.id} className="border rounded-md p-3 flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <Avatar className="h-7 w-7">
                    {b.photoPath ? <AvatarImage src={b.photoPath} alt={b.playerName} /> : null}
                    <AvatarFallback className="text-[10px]">{initialsFor(b.playerName)}</AvatarFallback>
                  </Avatar>
                  <span>{formatDateLong(b.start.split("T")[0])} — {formatIsoStartEnd(b.start)} · <button type="button" className="underline-offset-2 hover:underline" onClick={() => openNotesFor(b.profileId)}>{b.playerName}</button></span>
                </div>
                <Badge variant="outline">Done</Badge>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Sheet open={notesProfileId !== null} onOpenChange={(o) => { if (!o) setNotesProfileId(null); }}>
        <SheetContent side="right" className="sm:max-w-md w-full overflow-y-auto">
          {profileForNotes && (
            <>
              <SheetHeader>
                <div className="flex items-center gap-3">
                  <Avatar className="h-12 w-12">
                    {profileForNotes.photoPath ? <AvatarImage src={profileForNotes.photoPath} alt={profileForNotes.playerName} /> : null}
                    <AvatarFallback>{initialsFor(profileForNotes.playerName)}</AvatarFallback>
                  </Avatar>
                  <div>
                    <SheetTitle>{profileForNotes.playerName}</SheetTitle>
                    <SheetDescription>
                      {profileForNotes.parentName} · {formatPhone(profileForNotes.phone)}
                      {profileForNotes.email && <> · {profileForNotes.email}</>}
                    </SheetDescription>
                  </div>
                </div>
                {profileForNotes.notes && (
                  <div className="text-xs text-muted-foreground mt-2 italic">“{profileForNotes.notes}”</div>
                )}
              </SheetHeader>
              <div className="mt-4">
                <AdminCoachNotes profileId={profileForNotes.profileId} playerName={profileForNotes.playerName} parentName={profileForNotes.parentName} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function AvailabilityPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ weekly: Availability[]; overrides: DateOverride[] }>({
    queryKey: ["/api/availability"],
  });
  // editable per-day open/close
  const [draft, setDraft] = useState<Record<number, { enabled: boolean; start: string; end: string }>>({});

  useMemo(() => {
    if (!data) return;
    const next: typeof draft = {};
    for (let d = 0; d < 7; d++) {
      const found = data.weekly.find(w => w.dayOfWeek === d);
      next[d] = found
        ? { enabled: true, start: found.startTime, end: found.endTime }
        : { enabled: false, start: "08:00", end: "18:00" };
    }
    setDraft(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const rows: { dayOfWeek: number; startTime: string; endTime: string }[] = [];
      for (let d = 0; d < 7; d++) {
        const row = draft[d];
        if (row?.enabled) rows.push({ dayOfWeek: d, startTime: row.start, endTime: row.end });
      }
      await apiRequest("PUT", "/api/availability", rows);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/availability"] });
      qc.invalidateQueries({ queryKey: ["/api/slots"] });
      toast({ title: "Hours saved" });
    },
  });

  return (
    <div className="space-y-4 mt-4">
      <p className="text-sm text-muted-foreground">
        Set your weekly recurring hours. Bookings outside these times aren't possible.
      </p>
      {isLoading || !data ? (
        <p className="text-sm">Loading…</p>
      ) : (
        <Card>
          <CardContent className="p-4 space-y-2">
            {DAYS.map((label, d) => (
              <div key={d} className="grid grid-cols-[6rem_5rem_1fr_1fr] sm:grid-cols-[6rem_6rem_1fr_1fr_1fr] gap-2 items-center">
                <div className="font-medium">{label}</div>
                <Select
                  value={draft[d]?.enabled ? "open" : "closed"}
                  onValueChange={v => setDraft(s => ({ ...s, [d]: { ...s[d], enabled: v === "open" } }))}
                >
                  <SelectTrigger data-testid={`select-day-${d}`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="time"
                  value={draft[d]?.start ?? "08:00"}
                  onChange={e => setDraft(s => ({ ...s, [d]: { ...s[d], start: e.target.value } }))}
                  disabled={!draft[d]?.enabled}
                  data-testid={`input-day-${d}-start`}
                />
                <Input
                  type="time"
                  value={draft[d]?.end ?? "18:00"}
                  onChange={e => setDraft(s => ({ ...s, [d]: { ...s[d], end: e.target.value } }))}
                  disabled={!draft[d]?.enabled}
                  data-testid={`input-day-${d}-end`}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-availability">
          {save.isPending ? "Saving…" : "Save hours"}
        </Button>
      </div>
    </div>
  );
}

function OverridesPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery<{ weekly: Availability[]; overrides: DateOverride[] }>({
    queryKey: ["/api/availability"],
  });
  const { data: bookingsData } = useQuery<{ bookings: Booking[] }>({ queryKey: ["/api/bookings"] });
  const [date, setDate] = useState(todayISO());
  const [lastCancellation, setLastCancellation] = useState<{ date: string; rows: any[] } | null>(null);

  const affected = (bookingsData?.bookings ?? []).filter(b => b.start.startsWith(date + "T"));

  const add = useMutation({
    mutationFn: async () => {
      if (affected.length > 0) {
        const names = Array.from(new Set(affected.map(b => b.playerName))).join(", ");
        if (!window.confirm(
          `${affected.length} booking${affected.length === 1 ? "" : "s"} on ${date} will be cancelled and a text will be sent to: ${names}.\n\nContinue?`
        )) {
          throw new Error("cancelled");
        }
      }
      const res = await apiRequest("POST", "/api/overrides", { date, type: "closed" });
      return await res.json();
    },
    onSuccess: (result: any) => {
      qc.invalidateQueries({ queryKey: ["/api/availability"] });
      qc.invalidateQueries({ queryKey: ["/api/slots"] });
      qc.invalidateQueries({ queryKey: ["/api/bookings"] });
      const rows = result?.cancelledBookings ?? [];
      if (rows.length > 0) {
        setLastCancellation({ date, rows });
        toast({
          title: `Day blacked out`,
          description: `Cancelled ${rows.length} booking${rows.length === 1 ? "" : "s"} and texted ${new Set(rows.map((r: any) => r.phone)).size} parent${new Set(rows.map((r: any) => r.phone)).size === 1 ? "" : "s"}.`,
        });
      } else {
        toast({ title: "Day blacked out" });
      }
    },
  });
  const del = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/overrides/${id}`); },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/availability"] });
      qc.invalidateQueries({ queryKey: ["/api/slots"] });
    },
  });
  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardContent className="p-4 flex flex-col sm:flex-row gap-3 items-end">
          <div className="flex-1 w-full">
            <Label htmlFor="blackout-date">Block off a date</Label>
            <Input
              id="blackout-date" type="date" value={date}
              onChange={e => setDate(e.target.value)}
              data-testid="input-blackout-date"
            />
            {affected.length > 0 && (
              <p className="text-xs text-destructive mt-1" data-testid="text-affected-count">
                ⚠️ {affected.length} existing booking{affected.length === 1 ? "" : "s"} on this date — will be cancelled and parents will be texted.
              </p>
            )}
          </div>
          <Button onClick={() => add.mutate()} disabled={add.isPending} data-testid="button-add-blackout">
            {add.isPending ? "Working…" : "Add blackout"}
          </Button>
        </CardContent>
      </Card>
      {lastCancellation && (
        <Alert>
          <AlertDescription>
            <div className="font-medium mb-1">
              Cancelled {lastCancellation.rows.length} session{lastCancellation.rows.length === 1 ? "" : "s"} on {formatDateFull(lastCancellation.date)}:
            </div>
            <ul className="text-sm space-y-1">
              {lastCancellation.rows.map((r: any) => (
                <li key={r.id}>
                  • {r.playerName} ({formatPhone(r.phone)}) at {r.start.split("T")[1]} —{" "}
                  {r.smsOk ? <span className="text-primary">text sent</span> : <span className="text-destructive">text failed: {r.smsError}</span>}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        {(data?.overrides ?? []).filter(o => o.type === "closed").map(o => (
          <div key={o.id} className="border rounded-md p-3 flex items-center justify-between">
            <div>{formatDateFull(o.date)}</div>
            <Button variant="ghost" size="sm" onClick={() => del.mutate(o.id)} data-testid={`button-remove-blackout-${o.id}`}>
              Remove
            </Button>
          </div>
        ))}
        {(data?.overrides ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">No blackout dates.</p>
        )}
      </div>
    </div>
  );
}

function RemindersPanel() {
  const { data } = useQuery<{ reminders: any[] }>({ queryKey: ["/api/reminders"] });
  return (
    <div className="space-y-4 mt-4">
      <Alert>
        <AlertDescription>
          SMS reminders are scheduled for every booking — 5 days before and 2 days before, sent at
          9am. Add your Twilio credentials in the Settings tab to actually deliver them; until
          then, reminders run in dry-run mode (logged but not sent). Each row below shows what
          would go out.
        </AlertDescription>
      </Alert>
      <div className="space-y-2">
        {(data?.reminders ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">No reminders scheduled yet.</p>
        )}
        {(data?.reminders ?? []).map(r => (
          <div key={r.id} className="border rounded-md p-3 text-sm" data-testid={`row-reminder-${r.id}`}>
            <div className="flex items-center justify-between">
              <div>
                <Badge variant="outline" className="mr-2">{r.kind === "5day" ? "5-day" : "2-day"}</Badge>
                <span className="font-medium">{new Date(r.sendAt).toLocaleString()}</span>
                <span className="text-muted-foreground"> → {formatPhone(r.phone)}</span>
              </div>
              <Badge
                variant={r.status === "sent" ? "default" : r.status === "failed" ? "destructive" : "outline"}
              >
                {r.status}
              </Badge>
            </div>
            <div className="text-muted-foreground mt-1">{r.message}</div>
            {r.error && <div className="text-destructive mt-1">{r.error}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<Record<string, string>>({ queryKey: ["/api/settings"] });
  const [draft, setDraft] = useState<Record<string, string>>({});

  useMemo(() => {
    if (data) setDraft({
      coachName: data.coachName ?? "",
      coachPhone: data.coachPhone ?? "",
      coachEmail: data.coachEmail ?? "",
      resendApiKey: "", // never prefill; masked on server
      resendFromEmail: data.resendFromEmail ?? "",
      twilioAccountSid: "",
      twilioAuthToken: "",
      twilioFromPhone: data.twilioFromPhone ?? "",
      reminderChannel: data.reminderChannel ?? "email",
      publicSiteUrl: data.publicSiteUrl ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, string> = {};
      for (const k of ["coachName", "coachPhone", "coachEmail", "resendFromEmail", "twilioFromPhone", "reminderChannel", "publicSiteUrl"]) {
        if (draft[k]) payload[k] = draft[k];
      }
      for (const k of ["resendApiKey", "twilioAccountSid", "twilioAuthToken"]) {
        if (draft[k] && draft[k].trim().length > 0) payload[k] = draft[k].trim();
      }
      await apiRequest("PUT", "/api/settings", payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/settings"] });
      qc.invalidateQueries({ queryKey: ["/api/coach"] });
      toast({ title: "Settings saved" });
    },
  });

  const test = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/settings/test-email", {});
      return await res.json();
    },
    onSuccess: (result: any) => {
      if (result?.ok && result?.dryRun) {
        toast({ title: "Dry-run only", description: "Add a Resend API key and Save before testing real delivery." });
      } else if (result?.ok) {
        toast({ title: "Test email sent", description: "Check your inbox (and spam) for the test message." });
      } else {
        toast({ title: "Send failed", description: result?.error || "Unknown error", variant: "destructive" });
      }
    },
  });

  const testSms = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/settings/test-sms", {});
      return await res.json();
    },
    onSuccess: (result: any) => {
      if (result?.ok && result?.dryRun) {
        toast({ title: "Dry-run only", description: "Add Twilio credentials and Save before testing real delivery." });
      } else if (result?.ok) {
        toast({ title: "Test SMS sent", description: "Check your phone for the test message." });
      } else {
        toast({ title: "Send failed", description: result?.error || "Unknown error", variant: "destructive" });
      }
    },
  });

  if (isLoading || !data) return <p className="text-sm mt-4">Loading…</p>;

  return (
    <div className="space-y-4 mt-4">
      <Alert>
        <AlertDescription>
          The Text Coach button uses your coach phone. Booking confirmations and reminder emails are
          sent through Resend from your verified domain <code className="mx-1">skinnersoftball.com</code>.
          Manage your API keys at{" "}
          <a href="https://resend.com" target="_blank" rel="noreferrer" className="underline">resend.com</a>.
        </AlertDescription>
      </Alert>

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Reminders &amp; messaging</div>
          <div className="space-y-1">
            <Label htmlFor="reminderChannel">How customers are notified</Label>
            <select
              id="reminderChannel"
              value={draft.reminderChannel ?? "email"}
              onChange={e => setDraft(s => ({ ...s, reminderChannel: e.target.value }))}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              data-testid="select-reminder-channel"
            >
              <option value="email">Email only (recommended — free)</option>
              <option value="sms">SMS only (requires Twilio)</option>
              <option value="both">Both email and SMS</option>
            </select>
            <p className="text-xs text-muted-foreground">
              Applies to booking confirmations, blackout-day cancellations, and the 5-day &amp; 2-day reminders.
              You can switch any time — already-scheduled reminders pick up the new setting at send time.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="publicSiteUrl">Public site URL</Label>
            <Input
              id="publicSiteUrl"
              value={draft.publicSiteUrl ?? ""}
              onChange={e => setDraft(s => ({ ...s, publicSiteUrl: e.target.value }))}
              placeholder="https://www.perplexity.ai/computer/a/..."
              data-testid="input-public-url"
            />
            <p className="text-xs text-muted-foreground">
              The base URL used in confirmation emails so parents can find the “My appointments” page.
              Default is your current deployed site.
            </p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Coach info</div>
          <div className="space-y-1">
            <Label htmlFor="coachName">Coach name</Label>
            <Input id="coachName" value={draft.coachName ?? ""} onChange={e => setDraft(s => ({ ...s, coachName: e.target.value }))} data-testid="input-coach-name" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="coachPhone">Coach phone (Text Coach button)</Label>
            <Input id="coachPhone" value={draft.coachPhone ?? ""} onChange={e => setDraft(s => ({ ...s, coachPhone: e.target.value }))} placeholder="9079527860" data-testid="input-coach-phone" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="coachEmail">Coach email (booking notifications)</Label>
            <Input id="coachEmail" type="email" value={draft.coachEmail ?? ""} onChange={e => setDraft(s => ({ ...s, coachEmail: e.target.value }))} placeholder="you@example.com" data-testid="input-coach-email" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Email (Resend)</div>
            <Button variant="outline" size="sm" onClick={() => test.mutate()} disabled={test.isPending} data-testid="button-test-email">
              {test.isPending ? "Sending…" : "Send test email"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Sign up at <a href="https://resend.com" target="_blank" rel="noreferrer" className="underline">resend.com</a> (free 100/day) and paste your API key.
          </p>
          <div className="space-y-1">
            <Label htmlFor="resendFromEmail">From address</Label>
            <Input id="resendFromEmail" value={draft.resendFromEmail ?? ""} onChange={e => setDraft(s => ({ ...s, resendFromEmail: e.target.value }))} placeholder="Coach Skinner <coach@skinnersoftball.com>" data-testid="input-from-email" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="resendApiKey">Resend API key</Label>
            <Input id="resendApiKey" type="password" placeholder={data.resendApiKey ? `Saved: ${data.resendApiKey}` : "re_xxxxxxxx (paste to set/replace)"} value={draft.resendApiKey ?? ""} onChange={e => setDraft(s => ({ ...s, resendApiKey: e.target.value }))} data-testid="input-resend-key" />
            <p className="text-xs text-muted-foreground">Leave blank to keep the saved key. Paste a new key to replace it.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">SMS (Twilio)</div>
            <Button variant="outline" size="sm" onClick={() => testSms.mutate()} disabled={testSms.isPending} data-testid="button-test-sms">
              {testSms.isPending ? "Sending…" : "Send test SMS"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Get your Account SID, Auth Token, and a phone number from the{" "}
            <a href="https://console.twilio.com" target="_blank" rel="noreferrer" className="underline">Twilio Console</a>.
            On a trial account, recipient phones must be verified in Twilio first.
          </p>
          <div className="space-y-1">
            <Label htmlFor="twilioAccountSid">Account SID</Label>
            <Input id="twilioAccountSid" type="password" placeholder={data.twilioAccountSid ? `Saved: ${data.twilioAccountSid}` : "ACxxxxxxxx… (paste to set/replace)"} value={draft.twilioAccountSid ?? ""} onChange={e => setDraft(s => ({ ...s, twilioAccountSid: e.target.value }))} data-testid="input-twilio-sid" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="twilioAuthToken">Auth Token</Label>
            <Input id="twilioAuthToken" type="password" placeholder={data.twilioAuthToken ? `Saved: ${data.twilioAuthToken}` : "paste to set/replace"} value={draft.twilioAuthToken ?? ""} onChange={e => setDraft(s => ({ ...s, twilioAuthToken: e.target.value }))} data-testid="input-twilio-token" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="twilioFromPhone">From phone (your Twilio number)</Label>
            <Input id="twilioFromPhone" value={draft.twilioFromPhone ?? ""} onChange={e => setDraft(s => ({ ...s, twilioFromPhone: e.target.value }))} placeholder="+15551234567" data-testid="input-twilio-from" />
            <p className="text-xs text-muted-foreground">Use international format with the + and country code.</p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-settings">
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </div>

      <ChangeCredentialsCard />
    </div>
  );
}

function ChangeCredentialsCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");

  const change = useMutation({
    mutationFn: async () => {
      const payload: any = { currentPassword };
      if (phone.trim()) payload.phone = phone.trim();
      if (password.trim()) payload.password = password.trim();
      const res = await apiRequest("POST", "/api/auth/change", payload);
      return await res.json();
    },
    onSuccess: (result: any) => {
      setPassword(""); setCurrentPassword(""); setPhone("");
      if (result?.signedOut) {
        toast({ title: "Password changed", description: "Please sign in again with your new password." });
        qc.clear();
        qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
      } else {
        toast({ title: "Login updated" });
      }
    },
    onError: (e: any) => {
      toast({ title: "Couldn't update login", description: e?.message?.replace(/^\d+:\s*/, "") || "Try again", variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Admin login</div>
        <p className="text-xs text-muted-foreground">
          Change the phone or password used to sign in to admin. Leave a field blank to keep it.
          Password must be at least 6 characters. Changing the password signs you out everywhere.
        </p>
        <div className="space-y-1">
          <Label htmlFor="new-phone">New phone (optional)</Label>
          <Input id="new-phone" type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="Leave blank to keep current" data-testid="input-new-admin-phone" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="new-password">New password (optional)</Label>
          <Input id="new-password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Leave blank to keep current" data-testid="input-new-admin-password" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="current-password">Current password (required to confirm)</Label>
          <Input id="current-password" type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} data-testid="input-current-admin-password" />
        </div>
        <div className="flex justify-end">
          <Button onClick={() => change.mutate()} disabled={change.isPending || !currentPassword || (!phone && !password)} data-testid="button-change-admin">
            {change.isPending ? "Updating…" : "Update login"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

type MemberRow = {
  id: number; phone: string; email: string; parentName: string; playerName: string;
  notes: string; photoPath: string; createdAt: number;
  bookingCount: number; upcomingCount: number; lastBookingStart: string | null;
};

function MembersPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const labels = useTenantLabels();
  const { data, isLoading } = useQuery<{ profiles: MemberRow[] }>({ queryKey: ["/api/admin/profiles"] });
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<"createdAt" | "playerName" | "bookingCount" | "lastBookingStart">("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [notesProfileId, setNotesProfileId] = useState<number | null>(null);

  const del = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/admin/profiles/${id}`); },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/profiles"] });
      qc.invalidateQueries({ queryKey: ["/api/bookings"] });
      toast({ title: "Member removed" });
    },
    onError: (e: any) => toast({ title: "Couldn't delete", description: e?.message, variant: "destructive" }),
  });

  const filtered = useMemo(() => {
    const rows = data?.profiles ?? [];
    const q = query.trim().toLowerCase();
    const matched = q
      ? rows.filter((r) => {
          return (
            r.playerName.toLowerCase().includes(q) ||
            r.parentName.toLowerCase().includes(q) ||
            r.email.toLowerCase().includes(q) ||
            r.phone.includes(q.replace(/\D/g, "")) ||
            (r.notes || "").toLowerCase().includes(q)
          );
        })
      : rows;
    const sorted = [...matched].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "playerName") cmp = a.playerName.localeCompare(b.playerName);
      else if (sortKey === "bookingCount") cmp = a.bookingCount - b.bookingCount;
      else if (sortKey === "lastBookingStart") {
        const av = a.lastBookingStart ?? "";
        const bv = b.lastBookingStart ?? "";
        cmp = av < bv ? -1 : av > bv ? 1 : 0;
      } else cmp = a.createdAt - b.createdAt;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [data, query, sortKey, sortDir]);

  const profileForNotes = notesProfileId
    ? (data?.profiles ?? []).find((p) => p.id === notesProfileId)
    : null;

  function toggleSort(k: typeof sortKey) {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir(k === "playerName" ? "asc" : "desc"); }
  }

  function downloadCsv() {
    const rows = filtered;
    const header = [labels.attendee, labels.booker, "Phone", "Email", "Total bookings", "Upcoming", "Last booked", "Focus / notes", "Signed up"];
    const esc = (v: any) => {
      const s = v == null ? "" : String(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [header.map(esc).join(",")];
    for (const r of rows) {
      lines.push([
        r.playerName,
        r.parentName,
        formatPhone(r.phone),
        r.email,
        r.bookingCount,
        r.upcomingCount,
        r.lastBookingStart ? `${r.lastBookingStart.split("T")[0]} ${r.lastBookingStart.split("T")[1] ?? ""}`.trim() : "",
        r.notes || "",
        new Date(r.createdAt).toISOString().split("T")[0],
      ].map(esc).join(","));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const today = new Date().toISOString().split("T")[0];
    a.download = `coach-skinner-members-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4 mt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">All members</h2>
          <p className="text-sm text-muted-foreground">
            Everyone who has signed up. Click a name to view notes. Use the search box to filter.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email, phone…"
              className="pl-8 w-64"
              data-testid="input-members-search"
            />
          </div>
          <Button
            variant="outline"
            onClick={downloadCsv}
            disabled={filtered.length === 0}
            data-testid="button-download-members-csv"
          >
            <Download className="h-4 w-4 mr-2" /> Download CSV
          </Button>
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading members…</p>}
      {!isLoading && (data?.profiles ?? []).length === 0 && (
        <p className="text-sm text-muted-foreground">No members yet. As parents sign up, they'll show up here.</p>
      )}
      {!isLoading && (data?.profiles ?? []).length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground">No members match “{query}”.</p>
      )}

      {filtered.length > 0 && (
        <div className="border rounded-md overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 w-12"></th>
                <th className="text-left px-3 py-2 cursor-pointer select-none" onClick={() => toggleSort("playerName")}>
                  {labels.attendee} {sortKey === "playerName" && (sortDir === "asc" ? "▲" : "▼")}
                </th>
                <th className="text-left px-3 py-2">{labels.booker}</th>
                <th className="text-left px-3 py-2">Phone</th>
                <th className="text-left px-3 py-2">Email</th>
                <th className="text-right px-3 py-2 cursor-pointer select-none" onClick={() => toggleSort("bookingCount")}>
                  Bookings {sortKey === "bookingCount" && (sortDir === "asc" ? "▲" : "▼")}
                </th>
                <th className="text-left px-3 py-2 cursor-pointer select-none" onClick={() => toggleSort("lastBookingStart")}>
                  Last booked {sortKey === "lastBookingStart" && (sortDir === "asc" ? "▲" : "▼")}
                </th>
                <th className="text-left px-3 py-2 cursor-pointer select-none" onClick={() => toggleSort("createdAt")}>
                  Signed up {sortKey === "createdAt" && (sortDir === "asc" ? "▲" : "▼")}
                </th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={m.id} className="border-t hover:bg-muted/30" data-testid={`row-member-${m.id}`}>
                  <td className="px-3 py-2">
                    <Avatar className="h-8 w-8">
                      {m.photoPath ? <AvatarImage src={m.photoPath} alt={m.playerName} /> : null}
                      <AvatarFallback className="text-[10px]">{initialsFor(m.playerName)}</AvatarFallback>
                    </Avatar>
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="font-medium underline-offset-2 hover:underline text-left"
                      onClick={() => setNotesProfileId(m.id)}
                      data-testid={`button-member-notes-${m.id}`}
                    >
                      {m.playerName}
                    </button>
                    {m.notes && <div className="text-xs text-muted-foreground truncate max-w-[14rem]">“{m.notes}”</div>}
                  </td>
                  <td className="px-3 py-2">{m.parentName}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <a href={`tel:${m.phone}`} className="hover:underline">{formatPhone(m.phone)}</a>
                  </td>
                  <td className="px-3 py-2">
                    {m.email ? (
                      <a href={`mailto:${m.email}`} className="hover:underline">{m.email}</a>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {m.bookingCount}
                    {m.upcomingCount > 0 && (
                      <span className="text-xs text-muted-foreground ml-1">({m.upcomingCount} upcoming)</span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {m.lastBookingStart ? formatDateLong(m.lastBookingStart.split("T")[0]) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                    {new Date(m.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (confirm(`Remove ${m.playerName} and all of their bookings? This can't be undone.`)) {
                          del.mutate(m.id);
                        }
                      }}
                      data-testid={`button-delete-member-${m.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Sheet open={notesProfileId !== null} onOpenChange={(o) => { if (!o) setNotesProfileId(null); }}>
        <SheetContent side="right" className="sm:max-w-md w-full overflow-y-auto">
          {profileForNotes && (
            <>
              <SheetHeader>
                <div className="flex items-center gap-3">
                  <Avatar className="h-12 w-12">
                    {profileForNotes.photoPath ? <AvatarImage src={profileForNotes.photoPath} alt={profileForNotes.playerName} /> : null}
                    <AvatarFallback>{initialsFor(profileForNotes.playerName)}</AvatarFallback>
                  </Avatar>
                  <div>
                    <SheetTitle>{profileForNotes.playerName}</SheetTitle>
                    <SheetDescription>
                      {profileForNotes.parentName} · {formatPhone(profileForNotes.phone)}
                      {profileForNotes.email && <> · {profileForNotes.email}</>}
                    </SheetDescription>
                  </div>
                </div>
                {profileForNotes.notes && (
                  <div className="text-xs text-muted-foreground mt-2 italic">“{profileForNotes.notes}”</div>
                )}
              </SheetHeader>
              <div className="mt-4">
                <AdminCoachNotes
                  profileId={profileForNotes.id}
                  playerName={profileForNotes.playerName}
                  parentName={profileForNotes.parentName}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ===== Resources =====

const RESOURCE_CATEGORIES = [
  { id: "hitting", label: "Hitting" },
  { id: "pitching", label: "Pitching" },
  { id: "fielding", label: "Fielding" },
  { id: "catching", label: "Catching" },
  { id: "baserunning", label: "Baserunning" },
  { id: "strength", label: "Strength & conditioning" },
  { id: "mental", label: "Mental game" },
  { id: "general", label: "General" },
] as const;

type Resource = {
  id: number;
  type: "pdf" | "link" | "image" | "video";
  category: string;
  title: string;
  description: string;
  url: string;
  filePath: string;
  createdAt: number;
};

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

function ResourcesPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ resources: Resource[] }>({ queryKey: ["/api/resources"] });
  const [filterCat, setFilterCat] = useState<string>("all");

  // form state
  const [type, setType] = useState<"link" | "pdf" | "image" | "video">("link");
  const [category, setCategory] = useState<string>("general");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  function resetForm() {
    setTitle(""); setDescription(""); setUrl(""); setFile(null);
  }

  async function submit() {
    if (!title.trim()) return toast({ variant: "destructive", title: "Title is required" });
    if (type === "link" && !/^https?:\/\//i.test(url.trim())) {
      return toast({ variant: "destructive", title: "Enter a valid http/https URL" });
    }
    if (type !== "link" && !file) return toast({ variant: "destructive", title: "Pick a file to upload" });
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("type", type);
      fd.append("category", category);
      fd.append("title", title.trim());
      fd.append("description", description.trim());
      if (type === "link") fd.append("url", url.trim());
      else if (file) fd.append("file", file);
      const r = await fetch(`${API_BASE}/api/admin/resources`, { method: "POST", credentials: "include", body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || "Couldn't add resource");
      }
      resetForm();
      qc.invalidateQueries({ queryKey: ["/api/resources"] });
      toast({ title: "Resource added" });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Couldn't add", description: e?.message });
    } finally {
      setBusy(false);
    }
  }

  const del = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/admin/resources/${id}`); },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/resources"] });
      toast({ title: "Removed" });
    },
  });

  const resources = data?.resources ?? [];
  const filtered = filterCat === "all" ? resources : resources.filter(r => r.category === filterCat);

  function catLabel(id: string) { return RESOURCE_CATEGORIES.find(c => c.id === id)?.label || id; }
  function iconFor(t: string) {
    if (t === "pdf") return <FileText className="h-4 w-4" />;
    if (t === "image") return <ImageIcon className="h-4 w-4" />;
    if (t === "video") return <Video className="h-4 w-4" />;
    return <ExternalLink className="h-4 w-4" />;
  }

  return (
    <div className="space-y-6 mt-4">
      <Card>
        <CardContent className="p-5 space-y-3">
          <h2 className="text-base font-semibold">Add a resource</h2>
          <p className="text-sm text-muted-foreground">
            Anything you add here is visible to families who have signed up. The resource library is separate from the notes thread — things shared in notes stay private to each player.
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as any)}>
                <SelectTrigger data-testid="select-resource-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="link">External link (YouTube, article, website)</SelectItem>
                  <SelectItem value="pdf">PDF handout</SelectItem>
                  <SelectItem value="image">Photo / image</SelectItem>
                  <SelectItem value="video">Video file (mp4, mov, etc.)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Skill area</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger data-testid="select-resource-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RESOURCE_CATEGORIES.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label>Title</Label>
              <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Hitting drill — high tee" data-testid="input-resource-title" />
            </div>
            <div className="sm:col-span-2">
              <Label>Description (optional)</Label>
              <Textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="Short notes for families…" data-testid="input-resource-description" />
            </div>
            {type === "link" ? (
              <div className="sm:col-span-2">
                <Label>Link URL</Label>
                <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" data-testid="input-resource-url" />
              </div>
            ) : (
              <div className="sm:col-span-2">
                <Label>
                  {type === "pdf" ? "PDF file" : type === "video" ? "Video file" : "Image file"}
                </Label>
                <Input
                  type="file"
                  accept={
                    type === "pdf" ? "application/pdf" :
                    type === "video" ? "video/*" :
                    "image/*"
                  }
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  data-testid="input-resource-file"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {type === "video" ? "Max 200MB. Pick any video saved on your phone or computer." : "Max 200MB."}
                </p>
              </div>
            )}
          </div>
          <div className="flex justify-end">
            <Button onClick={submit} disabled={busy} data-testid="button-add-resource">
              <Upload className="h-4 w-4 mr-2" /> {busy ? "Adding…" : "Add resource"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-base font-semibold">Library ({resources.length})</h2>
        <div className="w-56">
          <Select value={filterCat} onValueChange={setFilterCat}>
            <SelectTrigger data-testid="select-filter-category"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All skill areas</SelectItem>
              {RESOURCE_CATEGORIES.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading resources…</p>}
      {!isLoading && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground">No resources yet in this category.</p>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        {filtered.map(r => (
          <div key={r.id} className="border rounded-md p-3 flex items-start justify-between gap-3" data-testid={`row-resource-${r.id}`}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {iconFor(r.type)}
                <Badge variant="secondary" className="text-[10px]">{catLabel(r.category)}</Badge>
              </div>
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="block font-medium hover:underline mt-1 break-words"
                data-testid={`link-resource-${r.id}`}
              >
                {r.title}
              </a>
              {r.description && <p className="text-xs text-muted-foreground mt-1">{r.description}</p>}
            </div>
            <div className="flex flex-col gap-1">
              <EditResourceDialog resource={r} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { if (confirm(`Remove “${r.title}”?`)) del.mutate(r.id); }}
                data-testid={`button-delete-resource-${r.id}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EditResourceDialog({ resource }: { resource: Resource }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(resource.title);
  const [description, setDescription] = useState(resource.description || "");
  const [category, setCategory] = useState(resource.category);
  const [linkUrl, setLinkUrl] = useState(resource.type === "link" ? resource.url : "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setTitle(resource.title);
    setDescription(resource.description || "");
    setCategory(resource.category);
    setLinkUrl(resource.type === "link" ? resource.url : "");
    setFile(null);
  }

  async function save() {
    if (!title.trim()) { toast({ title: "Title is required" }); return; }
    if (resource.type === "link" && !/^https?:\/\//i.test(linkUrl.trim())) {
      toast({ title: "Link must start with http:// or https://" });
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("title", title.trim());
      fd.append("description", description.trim());
      fd.append("category", category);
      if (resource.type === "link") fd.append("url", linkUrl.trim());
      if (file) fd.append("file", file);
      const r = await fetch(`${API_BASE}/api/admin/resources/${resource.id}`, {
        method: "PATCH",
        credentials: "include",
        body: fd,
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || "Couldn't save");
      }
      qc.invalidateQueries({ queryKey: ["/api/resources"] });
      toast({ title: "Resource updated" });
      setOpen(false);
    } catch (e: any) {
      toast({ title: e?.message || "Couldn't save" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" data-testid={`button-edit-resource-${resource.id}`}>
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit resource</DialogTitle>
          <DialogDescription>Update the details below. Leave the file blank to keep the current one.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {RESOURCE_CATEGORIES.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Title</Label>
            <Input value={title} onChange={e => setTitle(e.target.value)} data-testid={`input-edit-resource-title-${resource.id}`} />
          </div>
          <div>
            <Label>Description</Label>
            <Textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} />
          </div>
          {resource.type === "link" ? (
            <div>
              <Label>URL</Label>
              <Input value={linkUrl} onChange={e => setLinkUrl(e.target.value)} placeholder="https://…" />
            </div>
          ) : (
            <div>
              <Label>Replace file (optional)</Label>
              <Input
                type="file"
                accept={resource.type === "pdf" ? "application/pdf" : resource.type === "image" ? "image/*" : "video/*"}
                onChange={e => setFile(e.target.files?.[0] || null)}
              />
              <p className="text-xs text-muted-foreground mt-1">Current: {resource.filePath || "—"}</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy} data-testid={`button-save-resource-${resource.id}`}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===== Team / multi-admin =====

type AdminUser = { id: number; phone: string; name: string; isOwner: boolean; createdAt: number };

function TeamPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ admins: AdminUser[] }>({ queryKey: ["/api/admin/team"] });
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  const add = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/admin/team", { phone: phone.trim(), name: name.trim(), password });
      return r.json();
    },
    onSuccess: () => {
      setPhone(""); setName(""); setPassword("");
      qc.invalidateQueries({ queryKey: ["/api/admin/team"] });
      toast({ title: "Admin added", description: "They can now sign in at /#/admin with their phone and password." });
    },
    onError: (e: any) => toast({ variant: "destructive", title: "Couldn't add admin", description: e?.message?.replace(/^\d+:\s*/, "") }),
  });

  const del = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/admin/team/${id}`); },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/team"] });
      toast({ title: "Admin removed" });
    },
    onError: (e: any) => toast({ variant: "destructive", title: "Couldn't remove", description: e?.message?.replace(/^\d+:\s*/, "") }),
  });

  const admins = data?.admins ?? [];

  return (
    <div className="space-y-6 mt-4">
      <Card>
        <CardContent className="p-5 space-y-3">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <UserPlus className="h-4 w-4" /> Add another admin
          </h2>
          <p className="text-sm text-muted-foreground">
            Anyone you add here can sign in at /#/admin with the phone and password you set and will have full admin access. They cannot remove the owner account.
          </p>
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Assistant coach" data-testid="input-admin-name" />
            </div>
            <div>
              <Label>Phone *</Label>
              <Input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(317) 555-1234" inputMode="tel" data-testid="input-admin-phone" />
            </div>
            <div>
              <Label>Password *</Label>
              <div className="relative">
                <Input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="min 6 characters"
                  data-testid="input-admin-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                  aria-label="Toggle password visibility"
                >
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() => add.mutate()}
              disabled={!phone.trim() || !password || add.isPending}
              data-testid="button-add-admin"
            >
              {add.isPending ? "Adding…" : "Add admin"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div>
        <h2 className="text-base font-semibold mb-2">Current admins ({admins.length})</h2>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        <div className="space-y-2">
          {admins.map(a => (
            <div key={a.id} className="border rounded-md p-3 flex items-center justify-between" data-testid={`row-admin-${a.id}`}>
              <div className="flex items-center gap-3">
                {a.isOwner ? <Crown className="h-4 w-4 text-primary" /> : <ShieldCheck className="h-4 w-4 text-muted-foreground" />}
                <div>
                  <div className="font-medium">
                    {a.name || "(no name)"}
                    {a.isOwner && <Badge variant="secondary" className="ml-2 text-[10px]">Owner</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">{formatPhone(a.phone)} · added {new Date(a.createdAt).toLocaleDateString()}</div>
                </div>
              </div>
              {!a.isOwner && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { if (confirm(`Remove ${a.name || a.phone} as admin?`)) del.mutate(a.id); }}
                  data-testid={`button-delete-admin-${a.id}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">{title}</h2>
      {children}
    </section>
  );
}

function AdminNoteAttachment({ note }: { note: CoachingNote }) {
  if (note.mediaType === "image" && note.mediaPath) {
    const src = `${API_BASE}/uploads/notes/${note.mediaPath}`;
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="block mt-2">
        <img src={src} alt="attachment" className="rounded-md max-h-72 w-auto border" />
      </a>
    );
  }
  if (note.mediaType === "video" && note.mediaPath) {
    const src = `${API_BASE}/uploads/notes/${note.mediaPath}`;
    return <video src={src} controls preload="metadata" className="rounded-md max-h-72 w-full mt-2 border bg-black" />;
  }
  if (note.mediaType === "link" && note.mediaUrl) {
    return (
      <a href={note.mediaUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-2 text-sm underline break-all">
        <LinkIcon className="h-3.5 w-3.5 shrink-0" />
        {note.mediaUrl}
      </a>
    );
  }
  return null;
}

function AdminCoachNotes({ profileId, playerName, parentName }: { profileId: number; playerName: string; parentName: string }) {
  const labels = useTenantLabels();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [showLink, setShowLink] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { data, isLoading } = useQuery<{ notes: CoachingNote[] }>({
    queryKey: ["/api/notes", profileId],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/notes/${profileId}`);
      return r.json();
    },
  });

  const postMut = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append("text", text.trim());
      if (file) fd.append("file", file);
      if (linkUrl.trim()) fd.append("mediaUrl", linkUrl.trim());
      const r = await fetch(`${API_BASE}/api/notes/${profileId}`, { method: "POST", credentials: "include", body: fd });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error || body?.message || "Couldn't post note");
      }
      return r.json();
    },
    onSuccess: () => {
      setText("");
      setFile(null);
      setLinkUrl("");
      setShowLink(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      qc.invalidateQueries({ queryKey: ["/api/notes", profileId] });
      toast({ title: "Note posted", description: `${parentName || "The parent"} will be notified by email.` });
    },
    onError: (e: any) => toast({ variant: "destructive", title: "Couldn't post note", description: e.message }),
  });

  const delMut = useMutation({
    mutationFn: async (noteId: number) => {
      await apiRequest("DELETE", `/api/notes/${noteId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/notes", profileId] });
      toast({ title: "Note deleted" });
    },
  });

  const notes = data?.notes ?? [];

  return (
    <div className="space-y-3" data-testid="admin-coach-notes">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Coaching notes</h3>
        <p className="text-xs text-muted-foreground">Two-way thread with {parentName || "the parent"}. They get an email each time you post here.</p>
      </div>

      <div className="space-y-2 max-h-[55vh] overflow-y-auto">
        {isLoading && <p className="text-sm text-muted-foreground">Loading notes…</p>}
        {!isLoading && notes.length === 0 && (
          <p className="text-sm text-muted-foreground">No notes yet. Start the thread below.</p>
        )}
        {notes.map(n => (
          <div
            key={n.id}
            className={
              "rounded-md p-3 text-sm " +
              (n.author === "coach"
                ? "bg-primary/10 border-l-4 border-primary"
                : "bg-muted border-l-4 border-muted-foreground/30")
            }
            data-testid={`admin-note-${n.id}`}
          >
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
              <span className="font-medium">
                {n.author === "coach" ? "You (Coach)" : (parentName || labels.booker)}
              </span>
              <span className="flex items-center gap-2">
                <span>{new Date(n.createdAt).toLocaleString()}</span>
                <button
                  type="button"
                  onClick={() => { if (confirm("Delete this note?")) delMut.mutate(n.id); }}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label="Delete note"
                  data-testid={`button-delete-note-${n.id}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </span>
            </div>
            {n.text && <div className="whitespace-pre-wrap">{n.text}</div>}
            <AdminNoteAttachment note={n} />
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <Textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={`Write a note about ${playerName} (or attach a photo / video)…`}
          rows={3}
          maxLength={5000}
          data-testid="input-admin-new-note"
        />

        {file && (
          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-xs">
            <span className="truncate flex items-center gap-2">
              {file.type.startsWith("video/") ? <Video className="h-3.5 w-3.5" /> : <ImageIcon className="h-3.5 w-3.5" />}
              {file.name}
            </span>
            <button
              type="button"
              onClick={() => { setFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
              className="text-muted-foreground hover:text-foreground"
              data-testid="button-admin-clear-attachment"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {showLink && (
          <Input
            value={linkUrl}
            onChange={e => setLinkUrl(e.target.value)}
            placeholder="Paste a video or article link (https://…)"
            data-testid="input-admin-note-link"
          />
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0] || null; setFile(f); }}
          data-testid="input-admin-note-file"
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} data-testid="button-admin-attach-file">
              <Paperclip className="h-3.5 w-3.5 mr-1.5" /> Photo / video
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setShowLink(v => !v)} data-testid="button-admin-attach-link">
              <LinkIcon className="h-3.5 w-3.5 mr-1.5" /> {showLink ? "Hide link" : "Add link"}
            </Button>
          </div>
          <Button
            size="sm"
            onClick={() => postMut.mutate()}
            disabled={!(text.trim() || file || linkUrl.trim()) || postMut.isPending}
            data-testid="button-admin-post-note"
          >
            <Send className="h-3.5 w-3.5 mr-2" /> {postMut.isPending ? "Sending…" : "Post note"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BrandingPanel — tenant branding editor: name, sport, primary color, logo,
// hero image, tagline, about, contact info, and labels.  Shows a live
// preview card so the coach can see how their site will look.
// ---------------------------------------------------------------------------
type Branding = {
  id: number;
  slug: string;
  name: string;
  sport: string;
  primaryColor: string;
  logoPath: string;
  heroPath: string;
  tagline: string;
  about: string;
  contactPhone: string;
  contactEmail: string;
  contactLocation: string;
  bookerLabel: string;
  attendeeLabel: string;
  plan: string;
  trialEndsAt: number | null;
};

const SPORTS = [
  "softball", "baseball", "piano", "guitar", "tennis", "golf",
  "tutoring", "fitness", "martial_arts", "other",
] as const;
const BOOKER_LABEL_OPTIONS = ["Parent", "Client", "Member", "Guardian"];
const ATTENDEE_LABEL_OPTIONS = ["Player", "Student", "Athlete", "Member", "Client"];

function BrandingPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<Branding>({
    queryKey: ["/api/admin/branding"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/admin/branding");
      return r.json();
    },
  });
  const [draft, setDraft] = useState<Partial<Branding>>({});
  const merged: Partial<Branding> = { ...(data || {}), ...draft };

  const saveMut = useMutation({
    mutationFn: async (patch: Partial<Branding>) => {
      const r = await apiRequest("PATCH", "/api/admin/branding", patch);
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Branding saved" });
      setDraft({});
      qc.invalidateQueries({ queryKey: ["/api/admin/branding"] });
      qc.invalidateQueries({ queryKey: ["/api/_tenant"] });
    },
    onError: (e: any) => toast({ variant: "destructive", title: "Save failed", description: e.message }),
  });

  function set<K extends keyof Branding>(k: K, v: Branding[K]) {
    setDraft(d => ({ ...d, [k]: v as any }));
  }
  function uploadImage(kind: "logo" | "hero", file: File) {
    const fd = new FormData();
    fd.append(kind, file);
    fetch(`${"__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__"}/api/admin/branding/${kind}`, {
      method: "POST",
      body: fd,
      credentials: "include",
    })
      .then(r => r.json())
      .then(json => {
        if (json.path) {
          set(kind === "logo" ? "logoPath" : "heroPath", json.path);
          toast({ title: `${kind === "logo" ? "Logo" : "Hero image"} uploaded` });
          qc.invalidateQueries({ queryKey: ["/api/admin/branding"] });
          qc.invalidateQueries({ queryKey: ["/api/_tenant"] });
        } else {
          toast({ variant: "destructive", title: "Upload failed", description: json.error || "Unknown error" });
        }
      })
      .catch(e => toast({ variant: "destructive", title: "Upload failed", description: e.message }));
  }

  if (isLoading || !data) return <p className="text-sm text-muted-foreground">Loading branding…</p>;

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <Card>
        <CardContent className="p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold">Site identity</h2>
            <p className="text-xs text-muted-foreground">Your site URL is <code className="text-foreground">{data.slug}.lessonspot.app</code>.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="b-name">Business name</Label>
            <Input id="b-name" value={merged.name ?? ""} onChange={e => set("name", e.target.value)} data-testid="input-branding-name" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="b-sport">Sport / category</Label>
              <select id="b-sport" className="w-full h-10 rounded-md border bg-background px-3 text-sm" value={merged.sport ?? ""} onChange={e => set("sport", e.target.value)} data-testid="select-branding-sport">
                {SPORTS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="b-color">Primary color</Label>
              <div className="flex items-center gap-2">
                <input
                  id="b-color"
                  type="color"
                  className="h-10 w-12 rounded border bg-background cursor-pointer"
                  value={merged.primaryColor || "#0ea5e9"}
                  onChange={e => set("primaryColor", e.target.value)}
                  data-testid="input-branding-color"
                />
                <Input value={merged.primaryColor ?? ""} onChange={e => set("primaryColor", e.target.value)} className="flex-1 font-mono text-xs" />
              </div>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="b-tagline">Tagline</Label>
            <Input id="b-tagline" value={merged.tagline ?? ""} onChange={e => set("tagline", e.target.value)} placeholder="Private softball lessons in Greenwood, IN" data-testid="input-branding-tagline" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="b-about">About</Label>
            <Textarea id="b-about" rows={4} value={merged.about ?? ""} onChange={e => set("about", e.target.value)} placeholder="A short bio that appears on your booking page." data-testid="input-branding-about" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6 space-y-4">
          <h2 className="text-base font-semibold">Logo &amp; hero image</h2>
          <div className="space-y-2">
            <Label>Logo</Label>
            <div className="flex items-center gap-3">
              {merged.logoPath ? (
                <img src={merged.logoPath} alt="Logo" className="h-12 w-12 object-contain border rounded" />
              ) : (
                <div className="h-12 w-12 border rounded flex items-center justify-center text-xs text-muted-foreground">none</div>
              )}
              <label className="cursor-pointer">
                <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadImage("logo", f); }} data-testid="input-upload-logo" />
                <span className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
                  <Upload className="h-3.5 w-3.5" /> Upload
                </span>
              </label>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Hero image (optional)</Label>
            <div className="flex items-center gap-3">
              {merged.heroPath ? (
                <img src={merged.heroPath} alt="Hero" className="h-20 w-32 object-cover border rounded" />
              ) : (
                <div className="h-20 w-32 border rounded flex items-center justify-center text-xs text-muted-foreground">none</div>
              )}
              <label className="cursor-pointer">
                <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadImage("hero", f); }} data-testid="input-upload-hero" />
                <span className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
                  <Upload className="h-3.5 w-3.5" /> Upload
                </span>
              </label>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6 space-y-3">
          <h2 className="text-base font-semibold">Public contact info</h2>
          <p className="text-xs text-muted-foreground">Shown on booking confirmations and the "Text Coach" button.</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="b-cphone">Phone</Label>
              <Input id="b-cphone" value={merged.contactPhone ?? ""} onChange={e => set("contactPhone", e.target.value)} data-testid="input-branding-phone" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="b-cemail">Email</Label>
              <Input id="b-cemail" type="email" value={merged.contactEmail ?? ""} onChange={e => set("contactEmail", e.target.value)} data-testid="input-branding-email" />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="b-cloc">Location</Label>
            <Input id="b-cloc" value={merged.contactLocation ?? ""} onChange={e => set("contactLocation", e.target.value)} placeholder="Greenwood, IN" data-testid="input-branding-location" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6 space-y-3">
          <h2 className="text-base font-semibold">Audience labels</h2>
          <p className="text-xs text-muted-foreground">What do you call the person booking, and the person attending?</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="b-booker">Booker label</Label>
              <Input id="b-booker" list="booker-opts" value={merged.bookerLabel ?? ""} onChange={e => set("bookerLabel", e.target.value)} data-testid="input-branding-booker" />
              <datalist id="booker-opts">{BOOKER_LABEL_OPTIONS.map(o => <option key={o} value={o} />)}</datalist>
            </div>
            <div className="space-y-1">
              <Label htmlFor="b-attendee">Attendee label</Label>
              <Input id="b-attendee" list="attendee-opts" value={merged.attendeeLabel ?? ""} onChange={e => set("attendeeLabel", e.target.value)} data-testid="input-branding-attendee" />
              <datalist id="attendee-opts">{ATTENDEE_LABEL_OPTIONS.map(o => <option key={o} value={o} />)}</datalist>
            </div>
          </div>
          <div className="text-xs text-muted-foreground italic">
            Example: "{merged.bookerLabel || "Parent"} name" + "{merged.attendeeLabel || "Player"} name" on the booking form.
          </div>
        </CardContent>
      </Card>

      <div className="lg:col-span-2 flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => setDraft({})} disabled={Object.keys(draft).length === 0} data-testid="button-branding-reset">Reset</Button>
        <Button onClick={() => saveMut.mutate(draft)} disabled={Object.keys(draft).length === 0 || saveMut.isPending} data-testid="button-branding-save">
          {saveMut.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
