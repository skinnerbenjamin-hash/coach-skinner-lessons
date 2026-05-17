// Marketing landing page for the apex host (lessonspot.app).
//
// Rendered by App.tsx when window.__APEX__ === true.  Keeps the SPA bundle
// the same across hosts -- we just swap the top-level component.
//
// Tone: confident, plain language, no exclamations or emojis.  Mirrors the
// pricing decisions already locked in for the product:
//   $59/mo or $599/yr + $199 setup, 14-day trial no card,
//   DIY payments free / Stripe = 2%, slug.lessonspot.app subdomains.

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Check, CalendarDays, Users, BellRing, ShieldCheck, ArrowRight, MessageSquare, Library } from "lucide-react";

// Demo tenants seeded server-side at boot (see server/seedDemoTenants.ts).
// Each card links to demo-<sport>.lessonspot.app so visitors can poke around a
// realistic booking page before they sign up.
const DEMO_SPORTS: { slug: string; label: string; tagline: string; emoji: string }[] = [
  { slug: "demo-softball",  label: "Softball",      tagline: "Hitting, pitching, group clinics", emoji: "\u{1F94E}" },
  { slug: "demo-tennis",    label: "Tennis",        tagline: "Privates, semi-privates, clinics", emoji: "\u{1F3BE}" },
  { slug: "demo-golf",      label: "Golf",          tagline: "Range, short game, playing lessons", emoji: "\u{26F3}" },
  { slug: "demo-music",     label: "Music lessons", tagline: "Piano, guitar, voice", emoji: "\u{1F3B5}" },
  { slug: "demo-tutoring",  label: "Tutoring",      tagline: "Math, reading, test prep", emoji: "\u{1F4DA}" },
  { slug: "demo-wrestling", label: "Wrestling",     tagline: "Privates, practices, open mat", emoji: "\u{1F93C}" },
];

export default function Marketing() {
  function goSignup() {
    // Hash router; this works whether the page is at / or already at /#/something.
    window.location.hash = "#/signup";
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <header className="border-b bg-card">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <span
              aria-hidden
              className="inline-block w-6 h-6 rounded-full bg-primary"
            />
            <span>LessonSpot</span>
          </div>
          <nav className="flex items-center gap-2">
            <a
              href="#demos"
              className="text-sm text-muted-foreground hover:text-foreground px-3 py-2 hidden sm:inline-block"
              data-testid="link-marketing-demos"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById("demos")?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              Examples
            </a>
            <a
              href="#pricing"
              className="text-sm text-muted-foreground hover:text-foreground px-3 py-2"
              data-testid="link-marketing-pricing"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              Pricing
            </a>
            <Button
              variant="default"
              size="sm"
              onClick={goSignup}
              data-testid="button-marketing-signup-top"
            >
              Start free trial
            </Button>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-24">
        <div className="max-w-3xl">
          <p className="text-sm uppercase tracking-wide text-primary mb-3">
            For coaches, teachers, and trainers
          </p>
          <h1 className="text-3xl sm:text-5xl font-bold tracking-tight leading-tight">
            Your own booking site. Live in a minute.
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Stop juggling DMs and group chats. LessonSpot gives you a clean,
            branded booking page at <span className="font-semibold">your-name.lessonspot.app</span> — set your hours,
            add lesson types, and let families pick a time.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3">
            <Button size="lg" onClick={goSignup} data-testid="button-marketing-signup-hero">
              Start your free trial
            </Button>
            <Button size="lg" variant="outline" asChild>
              <a
                href="#features"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById("features")?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                See how it works
              </a>
            </Button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            14 days free. No card required.
          </p>
        </div>
      </section>

      {/* Feature grid */}
      <section id="features" className="mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16 border-t">
        <h2 className="text-2xl font-semibold mb-10">Everything you need to run lessons</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          <FeatureCard
            icon={<Users className="w-5 h-5" />}
            title="Group and 1-on-1 lessons"
            body="Run privates, semi-privates, and group clinics on the same calendar. Mark each availability window as solo, group, or both, and the right slots show up for the right lesson type — with real capacity tracking and waitlists when a group fills up."
          />
          <FeatureCard
            icon={<MessageSquare className="w-5 h-5" />}
            title="Private notes thread per student"
            body="Every player or student has their own private thread. Send specific feedback after a lesson, share a swing-fix video, and let the parent reply with questions or game footage. Nothing is shared with other families."
          />
          <FeatureCard
            icon={<Library className="w-5 h-5" />}
            title="Resource library"
            body="Build a library of drills, instructional videos, PDFs, and links your students can access any time. Organize by skill area — hitting, footwork, theory, test prep — whatever fits your program."
          />
          <FeatureCard
            icon={<CalendarDays className="w-5 h-5" />}
            title="Smart availability"
            body="Set weekly hours and one-off overrides. Duration-aware slots fit 30-minute and one-hour lessons on the same calendar without double-booking."
          />
          <FeatureCard
            icon={<BellRing className="w-5 h-5" />}
            title="Automatic reminders"
            body="Booking confirmations and reminders go out by email so people show up on time. No manual follow-up."
          />
          <FeatureCard
            icon={<ShieldCheck className="w-5 h-5" />}
            title="Your brand, your domain"
            body="Pick a subdomain on lessonspot.app, or bring your own. Add your logo, colors, and tagline. The booking page feels like yours."
          />
          <FeatureCard
            icon={<Check className="w-5 h-5" />}
            title="DIY payments included"
            body="Take payments however you already do — Venmo, Zelle, cash at the door. Or plug in Stripe later for card payments with just a 2% platform fee."
          />
        </div>
      </section>

      {/* See it for your sport */}
      <section id="demos" className="mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16 border-t">
        <div className="max-w-2xl mb-10">
          <h2 className="text-2xl font-semibold mb-3">See it for your sport</h2>
          <p className="text-muted-foreground">
            Pick a category and open a live preview of a LessonSpot booking page. Lesson types, hours, and branding are sport-specific so you can see what yours could look like.
          </p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {DEMO_SPORTS.map((s) => (
            <a
              key={s.slug}
              href={`https://${s.slug}.lessonspot.app`}
              target="_blank"
              rel="noreferrer"
              className="group block"
              data-testid={`link-demo-${s.slug}`}
            >
              <Card className="h-full hover:border-primary hover:shadow-sm transition">
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-3xl leading-none" aria-hidden>{s.emoji}</div>
                    <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition" />
                  </div>
                  <h3 className="font-semibold mt-4">{s.label}</h3>
                  <p className="text-sm text-muted-foreground mt-1">{s.tagline}</p>
                  <p className="text-xs text-muted-foreground mt-3 break-all">
                    {s.slug}.lessonspot.app
                  </p>
                </CardContent>
              </Card>
            </a>
          ))}
        </div>
        <p className="mt-6 text-sm text-muted-foreground">
          These are example sites. To make your own, start a free trial — it takes about a minute.
        </p>
      </section>

      {/* Pricing */}
      <section id="pricing" className="mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-20 border-t">
        <h2 className="text-2xl font-semibold mb-3">Simple pricing</h2>
        <p className="text-muted-foreground mb-10 max-w-2xl">
          One plan. Everything included. Cancel any time.
        </p>
        <div className="grid md:grid-cols-2 gap-6 max-w-3xl">
          <PriceCard
            title="Monthly"
            price="$59"
            period="/ month"
            note="Plus $199 one-time setup"
          />
          <PriceCard
            title="Annual"
            price="$599"
            period="/ year"
            note="Plus $199 one-time setup — save $109"
            highlight
          />
        </div>
        <ul className="mt-10 grid sm:grid-cols-2 gap-y-2 gap-x-8 max-w-3xl text-sm">
          <PricingBullet>14-day free trial, no card required</PricingBullet>
          <PricingBullet>Unlimited bookings and lesson types</PricingBullet>
          <PricingBullet>Group lessons and waitlists included</PricingBullet>
          <PricingBullet>Your own subdomain on lessonspot.app</PricingBullet>
          <PricingBullet>Automated email reminders</PricingBullet>
          <PricingBullet>DIY payments free, Stripe optional (2%)</PricingBullet>
        </ul>
        <div className="mt-10">
          <Button size="lg" onClick={goSignup} data-testid="button-marketing-signup-pricing">
            Start your free trial
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t mt-12">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-sm text-muted-foreground">
          <div>© {new Date().getFullYear()} LessonSpot</div>
          <div className="flex gap-4">
            <a href="mailto:hello@lessonspot.app" className="hover:text-foreground">
              hello@lessonspot.app
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
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

function PriceCard({
  title, price, period, note, highlight,
}: { title: string; price: string; period: string; note: string; highlight?: boolean }) {
  return (
    <Card className={highlight ? "border-primary border-2" : undefined}>
      <CardContent className="pt-6">
        <div className="flex items-baseline justify-between mb-4">
          <h3 className="font-semibold">{title}</h3>
          {highlight && (
            <span className="text-xs uppercase tracking-wide text-primary font-semibold">
              Best value
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-1 mb-3">
          <span className="text-4xl font-bold">{price}</span>
          <span className="text-muted-foreground">{period}</span>
        </div>
        <p className="text-sm text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  );
}

function PricingBullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
      <span>{children}</span>
    </li>
  );
}
