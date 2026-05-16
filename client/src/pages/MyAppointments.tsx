import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  normalizePhone, formatPhone, formatDateFull, formatIsoStartEnd, isWithin24h,
  todayISO, addDays, formatDateLong, formatTime,
} from "@/lib/scheduling";
import { Lock, Search, Pencil } from "lucide-react";

type Booking = {
  id: number; start: string; bookingGroup: string; createdAt: number;
  parentName: string; playerName: string; phone: string; email: string; notes: string;
};
type Profile = { id: number; phone: string; email: string; parentName: string; playerName: string; notes: string };

export default function MyAppointments() {
  const [emailInput, setEmailInput] = useState("");
  const [activeEmail, setActiveEmail] = useState<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  // Restore last-used email so people don't have to retype after edits
  useEffect(() => {
    try {
      const stored = localStorage.getItem("csb-last-email");
      if (stored) {
        setEmailInput(stored);
        setActiveEmail(stored);
      }
    } catch {}
  }, []);

  const { data, isLoading, isError } = useQuery<{ profile: Profile | null; bookings: Booking[] }>({
    queryKey: ["/api/my-bookings-by-email", activeEmail],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/my-bookings-by-email/${encodeURIComponent(activeEmail!)}`);
      return r.json();
    },
    enabled: !!activeEmail,
  });

  const cancelMut = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/bookings/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/my-bookings-by-email"] });
      toast({ title: "Appointment cancelled" });
    },
    onError: (e: any) => toast({ variant: "destructive", title: "Couldn't cancel", description: e.message }),
  });

  function onLookup() {
    const email = emailInput.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      toast({ variant: "destructive", title: "Enter a valid email" });
      return;
    }
    try { localStorage.setItem("csb-last-email", email); } catch {}
    setActiveEmail(email);
  }

  const upcoming = (data?.bookings ?? []).filter(b => b.start >= todayISO() + "T00:00");
  const past = (data?.bookings ?? []).filter(b => b.start < todayISO() + "T00:00");

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">My appointments</h1>
        <p className="text-sm text-muted-foreground">
          Enter the email you booked with to view, reschedule, cancel, or update your info.
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          <b>Cancellation policy:</b> Cancellations or no-shows within 24 hours of the scheduled session are subject to a $30 fee per 30-minute session, billed at the next lesson.
        </p>
      </div>

      <Card>
        <CardContent className="p-6 flex flex-col sm:flex-row gap-3 items-end">
          <div className="flex-1 w-full">
            <Label htmlFor="lookup-email">Email</Label>
            <Input
              id="lookup-email"
              data-testid="input-lookup-email"
              type="email"
              inputMode="email"
              placeholder="you@example.com"
              value={emailInput}
              onChange={e => setEmailInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && onLookup()}
            />
          </div>
          <Button onClick={onLookup} data-testid="button-lookup">
            <Search className="h-4 w-4 mr-2" /> Look up
          </Button>
        </CardContent>
      </Card>

      {isError && (
        <Alert variant="destructive"><AlertDescription>Couldn't load. Try again.</AlertDescription></Alert>
      )}

      {activeEmail && !isLoading && data && (
        <>
          {!data.profile ? (
            <Alert>
              <AlertDescription>
                No account found for {activeEmail}. Make sure you used the same email
                when booking, or <a className="underline" href="/#/" data-testid="link-book-new">book your first session</a>.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="text-sm text-muted-foreground">
                  Showing appointments for{" "}
                  <span className="text-foreground font-medium">
                    {data.profile.playerName}
                  </span>{" "}
                  · {formatPhone(data.profile.phone)} · {data.profile.email}
                </div>
                <EditProfileDialog profile={data.profile} />
              </div>

              <Section title="Upcoming">
                {upcoming.length === 0 && (
                  <p className="text-sm text-muted-foreground">No upcoming sessions.</p>
                )}
                <div className="space-y-2">
                  {upcoming.map(b => (
                    <BookingRow
                      key={b.id}
                      b={b}
                      onCancel={() => cancelMut.mutate(b.id)}
                    />
                  ))}
                </div>
              </Section>

              {past.length > 0 && (
                <Section title="Past">
                  <div className="space-y-2 opacity-70">
                    {past.map(b => (
                      <div key={b.id} className="flex items-center justify-between border rounded-md p-3 text-sm">
                        <div>{formatDateLong(b.start.split("T")[0])} — {formatIsoStartEnd(b.start)}</div>
                        <Badge variant="outline">Completed</Badge>
                      </div>
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}
        </>
      )}
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

function BookingRow({ b, onCancel }: { b: Booking; onCancel: () => void }) {
  const locked = isWithin24h(b.start);
  return (
    <div
      className="flex items-center justify-between border rounded-md p-3 gap-3"
      data-testid={`row-booking-${b.id}`}
    >
      <div>
        <div className="font-medium">{formatDateFull(b.start.split("T")[0])}</div>
        <div className="text-sm text-muted-foreground">{formatIsoStartEnd(b.start)}</div>
      </div>
      <div className="flex items-center gap-2">
        {locked ? (
          <Badge variant="outline" className="text-xs gap-1">
            <Lock className="h-3 w-3" /> Within 24 hr
          </Badge>
        ) : (
          <>
            <RescheduleDialog booking={b} />
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
              data-testid={`button-cancel-${b.id}`}
            >
              Cancel
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function EditProfileDialog({ profile }: { profile: Profile }) {
  const [open, setOpen] = useState(false);
  const [parentName, setParentName] = useState(profile.parentName);
  const [playerName, setPlayerName] = useState(profile.playerName);
  const [email, setEmail] = useState(profile.email);
  const [phone, setPhone] = useState(profile.phone);
  const [notes, setNotes] = useState(profile.notes || "");
  const qc = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      setParentName(profile.parentName);
      setPlayerName(profile.playerName);
      setEmail(profile.email);
      setPhone(profile.phone);
      setNotes(profile.notes || "");
    }
  }, [open, profile]);

  const mut = useMutation({
    mutationFn: async () => {
      // Use the CURRENT email as proof of ownership
      const body = {
        proofEmail: profile.email,
        parentName,
        playerName,
        email: email.trim(),
        phone,
        notes,
      };
      const r = await apiRequest("PATCH", `/api/profile/${profile.id}`, body);
      return r.json();
    },
    onSuccess: (updated: Profile) => {
      // If email changed, store the new email for next lookup
      if (updated?.email) {
        try { localStorage.setItem("csb-last-email", updated.email.toLowerCase()); } catch {}
      }
      qc.invalidateQueries({ queryKey: ["/api/my-bookings-by-email"] });
      toast({ title: "Info updated" });
      setOpen(false);
    },
    onError: (e: any) => toast({ variant: "destructive", title: "Couldn't update", description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-edit-profile">
          <Pencil className="h-3.5 w-3.5 mr-2" /> Edit info
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit your info</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="edit-parent">Parent name</Label>
            <Input id="edit-parent" value={parentName} onChange={e => setParentName(e.target.value)} data-testid="input-edit-parent" />
          </div>
          <div>
            <Label htmlFor="edit-player">Player name</Label>
            <Input id="edit-player" value={playerName} onChange={e => setPlayerName(e.target.value)} data-testid="input-edit-player" />
          </div>
          <div>
            <Label htmlFor="edit-email">Email</Label>
            <Input id="edit-email" type="email" value={email} onChange={e => setEmail(e.target.value)} data-testid="input-edit-email" />
          </div>
          <div>
            <Label htmlFor="edit-phone">Phone</Label>
            <Input id="edit-phone" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} data-testid="input-edit-phone" />
          </div>
          <div>
            <Label htmlFor="edit-notes">Notes (allergies, level, etc.)</Label>
            <Input id="edit-notes" value={notes} onChange={e => setNotes(e.target.value)} data-testid="input-edit-notes" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            onClick={() => mut.mutate()}
            disabled={mut.isPending}
            data-testid="button-save-profile"
          >
            {mut.isPending ? "Saving..." : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RescheduleDialog({ booking }: { booking: Booking }) {
  const [open, setOpen] = useState(false);
  const [newStart, setNewStart] = useState<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const today = todayISO();
  const range = { start: today, end: addDays(today, 30) };

  const { data } = useQuery<{ days: { date: string; slots: { start: string; booked: boolean }[] }[] }>({
    queryKey: ["/api/slots", range.start, range.end, "resched", booking.id],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/slots?start=${range.start}&end=${range.end}`);
      return r.json();
    },
    enabled: open,
  });

  const mut = useMutation({
    mutationFn: async () => {
      if (!newStart) throw new Error("Pick a new time");
      await apiRequest("PATCH", `/api/bookings/${booking.id}`, { newStart });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/my-bookings-by-email"] });
      toast({ title: "Rescheduled" });
      setOpen(false);
      setNewStart(null);
    },
    onError: (e: any) => toast({ variant: "destructive", title: "Couldn't reschedule", description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid={`button-reschedule-${booking.id}`}>Reschedule</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Reschedule session</DialogTitle>
        </DialogHeader>
        <div className="text-sm text-muted-foreground">
          Currently: {formatDateFull(booking.start.split("T")[0])} — {formatIsoStartEnd(booking.start)}
        </div>
        <div className="max-h-[55vh] overflow-y-auto space-y-3 pt-2">
          {data?.days.map(d => {
            const open = d.slots.filter(s => !s.booked && !isWithin24h(s.start));
            if (open.length === 0) return null;
            return (
              <div key={d.date}>
                <div className="text-sm font-medium mb-1">{formatDateLong(d.date)}</div>
                <div className="flex flex-wrap gap-1.5">
                  {open.map(s => (
                    <button
                      key={s.start}
                      onClick={() => setNewStart(s.start)}
                      data-testid={`button-resched-${s.start}`}
                      className={
                        "text-xs px-2 py-1.5 rounded-md border " +
                        (newStart === s.start
                          ? "border-primary bg-primary text-primary-foreground"
                          : "hover-elevate")
                      }
                    >
                      {formatTime(s.start.split("T")[1])}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            onClick={() => mut.mutate()}
            disabled={!newStart || mut.isPending}
            data-testid="button-confirm-reschedule"
          >
            Confirm new time
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
