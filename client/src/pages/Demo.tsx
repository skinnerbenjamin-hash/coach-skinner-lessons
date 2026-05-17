// Offer-focused landing page rendered at lessonspot.app/#/demo.
//
// Layout:
//   1. Hero with the big offer ("See a real coach's live page")
//   2. Two click-to-play video walkthroughs side-by-side: client + admin
//   3. Live demo CTA (opens skinner.lessonspot.app or demo-softball)
//   4. Lead-capture form ("Want a 1-on-1 walkthrough with me?")
//   5. Closing free-trial CTA
//
// The form POSTs to /api/demo-request which emails Skinner via Resend so he
// can follow up to schedule.

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  ArrowRight,
  ExternalLink,
  Check,
  Play,
  Eye,
  Calendar,
  Users,
  Library,
  MessageSquare,
} from "lucide-react";

const LIVE_DEMO_URL = "https://demo-softball.lessonspot.app";

export default function Demo() {
  function goSignup() {
    window.location.hash = "#/signup";
  }
  function goHome() {
    window.location.hash = "#/";
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <header className="border-b bg-card sticky top-0 z-30 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex items-center justify-between">
          <button
            onClick={goHome}
            className="flex items-center gap-2 font-semibold hover:opacity-80 transition"
            data-testid="link-demo-home"
          >
            <span aria-hidden className="inline-block w-6 h-6 rounded-full bg-primary" />
            <span>LessonSpot</span>
          </button>
          <nav className="flex items-center gap-2">
            <button
              onClick={goHome}
              className="text-sm text-muted-foreground hover:text-foreground px-3 py-2 hidden sm:inline-block"
              data-testid="link-demo-back"
            >
              Back to home
            </button>
            <Button
              variant="default"
              size="sm"
              onClick={goSignup}
              data-testid="button-demo-signup-top"
            >
              Start free trial
            </Button>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-background to-background pointer-events-none" />
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6 pt-16 pb-12 sm:pt-24 sm:pb-16 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border bg-card px-4 py-1.5 text-sm text-muted-foreground mb-6">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            Live demo — no sign-up required
          </div>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight leading-tight max-w-4xl mx-auto">
            See a real coach's live page in action.
          </h1>
          <p className="mt-6 text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Two short walkthroughs: one shows what your families see when they book,
            the other shows you the admin side running the whole program.
          </p>
        </div>
      </section>

      {/* Videos */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-12 sm:pb-16">
        <div className="grid lg:grid-cols-2 gap-8">
          <VideoCard
            eyebrow="What your families see"
            title="Booking a lesson"
            duration="57 sec"
            src="/demo/client.mp4"
            poster="/demo/client-poster.jpg"
            testId="video-demo-client"
          />
          <VideoCard
            eyebrow="What you see"
            title="Running the program"
            duration="51 sec"
            src="/demo/admin.mp4"
            poster="/demo/admin-poster.jpg"
            testId="video-demo-admin"
          />
        </div>
        <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center items-center">
          <a
            href={LIVE_DEMO_URL}
            target="_blank"
            rel="noreferrer"
            data-testid="link-demo-live"
          >
            <Button size="lg" className="text-base px-8 py-6 h-auto shadow-lg shadow-primary/20">
              Try the live demo yourself
              <ExternalLink className="w-4 h-4 ml-2" />
            </Button>
          </a>
          <Button
            size="lg"
            variant="outline"
            className="text-base px-8 py-6 h-auto"
            onClick={goSignup}
            data-testid="button-demo-signup-hero"
          >
            Start your free trial
          </Button>
        </div>
        <p className="mt-4 text-sm text-muted-foreground text-center">
          Click around, pick a time, fill in info — see exactly what your families would see.
        </p>
      </section>

      {/* What you saw */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16 border-t">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="text-2xl sm:text-3xl font-semibold mb-3">What's in the walkthrough</h2>
          <p className="text-muted-foreground">
            Every screen above is the actual product. Yours would look the same with your branding,
            your lesson types, and your schedule.
          </p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <FeatureTile
            icon={<Calendar className="w-5 h-5" />}
            title="Smart calendar"
            body="Set your hours once. Duration-aware slots fit 30-min and 1-hour lessons on the same calendar without double-booking."
          />
          <FeatureTile
            icon={<Users className="w-5 h-5" />}
            title="Group + 1-on-1"
            body="Run privates, semi-privates, and group clinics from the same calendar with real capacity tracking."
          />
          <FeatureTile
            icon={<MessageSquare className="w-5 h-5" />}
            title="Private threads"
            body="Every athlete gets their own thread to share lesson notes, drill videos, and parent replies. Nothing is shared with other families."
          />
          <FeatureTile
            icon={<Library className="w-5 h-5" />}
            title="Resource library"
            body="A 24/7 library of drills, instructional videos, and PDFs — organized by skill area you teach."
          />
        </div>
      </section>

      {/* Lead capture */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-20 border-t">
        <div className="grid lg:grid-cols-2 gap-10 items-start max-w-5xl mx-auto">
          <div>
            <p className="text-sm uppercase tracking-wide text-primary mb-3">
              Free 1-on-1 walkthrough
            </p>
            <h2 className="text-2xl sm:text-3xl font-semibold mb-4">
              Want me to walk you through it personally?
            </h2>
            <p className="text-muted-foreground leading-relaxed mb-6">
              Send your info and I'll personally reach out to schedule a quick screen-share. I'll
              show you the admin side, answer your questions, and help you decide if LessonSpot is
              a fit for your program.
            </p>
            <ul className="space-y-3 text-sm">
              <Bullet>15-minute call, screen-share, zero pressure</Bullet>
              <Bullet>I'll show you how to set up lesson types and hours</Bullet>
              <Bullet>I'll answer "would this work for my program?"</Bullet>
              <Bullet>14-day free trial — no card required to start</Bullet>
            </ul>
          </div>
          <DemoRequestForm />
        </div>
      </section>

      {/* Closing CTA */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-20 border-t">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-2xl sm:text-3xl font-semibold mb-4">
            Or just start your own free trial.
          </h2>
          <p className="text-muted-foreground mb-8">
            14 days free. No card. Build your page in under 10 minutes.
          </p>
          <Button
            size="lg"
            onClick={goSignup}
            className="text-base px-8 py-6 h-auto"
            data-testid="button-demo-signup-bottom"
          >
            Start free trial
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t mt-12">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-sm text-muted-foreground">
          <div>© {new Date().getFullYear()} LessonSpot</div>
          <div className="flex gap-4">
            <button onClick={goHome} className="hover:text-foreground" data-testid="link-demo-footer-home">
              Home
            </button>
            <a href="mailto:hello@lessonspot.app" className="hover:text-foreground">
              hello@lessonspot.app
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function VideoCard({
  eyebrow, title, duration, src, poster, testId,
}: { eyebrow: string; title: string; duration: string; src: string; poster: string; testId: string }) {
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  function handlePlay() {
    setPlaying(true);
    // useEffect-style: play once mounted
    setTimeout(() => {
      videoRef.current?.play().catch(() => { /* ignore */ });
    }, 50);
  }

  return (
    <div className="space-y-3">
      <div className="relative rounded-2xl overflow-hidden shadow-xl shadow-primary/10 border bg-card aspect-video group">
        {playing ? (
          <video
            ref={videoRef}
            src={src}
            poster={poster}
            controls
            playsInline
            preload="metadata"
            className="w-full h-full object-cover bg-black"
            data-testid={testId}
          />
        ) : (
          <button
            type="button"
            onClick={handlePlay}
            className="block w-full h-full relative"
            aria-label={`Play ${title}`}
            data-testid={`${testId}-play`}
          >
            <img src={poster} alt={title} className="absolute inset-0 w-full h-full object-cover" />
            <div className="absolute inset-0 bg-black/15 group-hover:bg-black/25 transition" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-20 h-20 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-2xl shadow-primary/40 group-hover:scale-110 transition">
                <Play className="w-8 h-8 ml-1" fill="currentColor" />
              </div>
            </div>
            <div className="absolute bottom-3 right-3 rounded-md bg-black/70 text-white text-xs font-medium px-2 py-1">
              {duration}
            </div>
          </button>
        )}
      </div>
      <div className="px-1">
        <p className="text-xs uppercase tracking-wide text-primary font-semibold">{eyebrow}</p>
        <h3 className="text-lg font-semibold mt-1">{title}</h3>
      </div>
    </div>
  );
}

function FeatureTile({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="w-10 h-10 rounded-md bg-primary/10 text-primary flex items-center justify-center mb-4">
          {icon}
        </div>
        <h3 className="font-semibold mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
      </CardContent>
    </Card>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
      <span>{children}</span>
    </li>
  );
}

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

function DemoRequestForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim()) {
      setError("Name and email are required.");
      return;
    }
    setState("submitting");
    setError(null);
    try {
      const resp = await fetch(`${API_BASE}/api/demo-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone, message }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body?.error || "Something went wrong");
      }
      setState("success");
    } catch (err: any) {
      setState("error");
      setError(err?.message || "Something went wrong");
    }
  }

  if (state === "success") {
    return (
      <Card className="border-primary/40">
        <CardContent className="pt-6 text-center py-12">
          <div className="w-14 h-14 mx-auto rounded-full bg-primary/10 text-primary flex items-center justify-center mb-4">
            <Check className="w-7 h-7" />
          </div>
          <h3 className="text-xl font-semibold mb-2">Got it — I'll be in touch.</h3>
          <p className="text-muted-foreground text-sm">
            I'll personally reach out within a day to set up a quick walkthrough. Thanks for
            checking out LessonSpot.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="demo-name">Your name</Label>
            <Input
              id="demo-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Coach"
              required
              data-testid="input-demo-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="demo-email">Email</Label>
            <Input
              id="demo-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              data-testid="input-demo-email"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="demo-phone">Phone (optional)</Label>
            <Input
              id="demo-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(317) 555-0123"
              data-testid="input-demo-phone"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="demo-message">Anything I should know? (optional)</Label>
            <Textarea
              id="demo-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What sport, roughly how many students, biggest scheduling headache..."
              rows={3}
              data-testid="textarea-demo-message"
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" data-testid="text-demo-error">
              {error}
            </p>
          )}
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={state === "submitting"}
            data-testid="button-demo-submit"
          >
            {state === "submitting" ? "Sending..." : "Request a walkthrough"}
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            No spam. I'll only use this to reach out about LessonSpot.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
