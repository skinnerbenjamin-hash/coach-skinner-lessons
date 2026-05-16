import { useState } from "react";
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
import { Lock, Search } from "lucide-react";

type Booking = {
  id: number; start: string; bookingGroup: string; createdAt: number;
  parentName: string; playerName: string; phone: string; notes: string;
};
type Profile = { id: number; phone: string; parentName: string; playerName: string; notes: string };

export default function MyAppointments() {
  const [phoneInput, setPhoneInput] = useState("");
  const [activePhone, setActivePhone] = useState<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, isError } = useQuery<{ profile: Profile | null; bookings: Booking[] }>({
    queryKey: ["/api/my-bookings", activePhone],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/my-bookings/${activePhone}`);
      return r.json();
    },
    enabled: !!activePhone,
  });

  const cancelMut = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/bookings/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/my-bookings"] });
      toast({ title: "Appointment cancelled" });
    },
    onError: (e: any) => toast({ variant: "destructive", title: "Couldn't cancel", description: e.message }),
  });

  function onLookup() {
    const digits = normalizePhone(phoneInput);
    if (digits.length < 10) {
      toast({ variant: "destructive", title: "Enter a full phone number" });
      return;
    }
    setActivePhone(digits);
  }

  const upcoming = (data?.bookings ?? []).filter(b => b.start >= todayISO() + "T00:00");
  const past = (data?.bookings ?? []).filter(b => b.start < todayISO() + "T00:00");

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">My appointments</h1>
        <p className="text-sm text-muted-foreground">
          Enter the phone number you booked with to view, reschedule, or cancel.
        </p>
      </div>

      <Card>
        <CardContent className="p-6 flex flex-col sm:flex-row gap-3 items-end">
          <div className="flex-1 w-full">
            <Label htmlFor="lookup-phone">Phone number</Label>
            <Input
              id="lookup-phone"
              data-testid="input-lookup-phone"
              inputMode="tel"
              placeholder="(317) 555-1234"
              value={phoneInput}
              onChange={e => setPhoneInput(e.target.value)}
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

      {activePhone && !isLoading && data && (
        <>
          {!data.profile ? (
            <Alert>
              <AlertDescription>
                No profile found for {formatPhone(activePhone)}. Make sure you used the same number
                when booking, or <a className="underline" href="/#/" data-testid="link-book-new">book your first session</a>.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="text-sm text-muted-foreground">
                Showing appointments for{" "}
                <span className="text-foreground font-medium">
                  {data.profile.playerName}
                </span>{" "}
                · {formatPhone(data.profile.phone)}
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
      qc.invalidateQueries({ queryKey: ["/api/my-bookings"] });
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
