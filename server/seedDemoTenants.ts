// Idempotent demo-tenant seeder.
//
// Creates a small set of read-only "preview" tenants so the marketing site
// can link to a real booking page for each sport.  Slugs are stable
// (demo-softball, demo-tennis, ...) so the marketing card URLs never change.
//
// Behavior:
//   - Runs once on server boot, after migrations.
//   - For each demo slug: if a tenant with that slug already exists, leaves
//     it alone (so any local edits are preserved).  If not, creates it with
//     sport-appropriate branding, lesson types, categories, and Mon-Sat
//     evening availability.
//   - Never seeds bookings or profiles -- the booking page renders the
//     calendar from availability alone.
//
// To re-seed a demo tenant from scratch, delete its row from the tenants
// table and restart the server.

import Database from "better-sqlite3";

type DemoLessonType = {
  name: string;
  durationMin: number;
  capacity: number;
  isGroup: 0 | 1;
};

type DemoCategory = { slug: string; label: string };

type DemoTenant = {
  slug: string;            // demo-<sport>; becomes demo-<sport>.lessonspot.app
  name: string;            // business name shown on the booking page
  sport: string;           // canonical sport key
  primaryColor: string;    // hex; drives --primary CSS var
  tagline: string;
  about: string;
  bookerLabel: string;
  attendeeLabel: string;
  contactEmail: string;
  contactLocation: string;
  lessonTypes: DemoLessonType[];
  categories: DemoCategory[];
};

const DEMO_TENANTS: DemoTenant[] = [
  {
    slug: "demo-softball",
    name: "Coach Riley Softball",
    sport: "softball",
    primaryColor: "#0ea5e9",
    tagline: "Hitting, pitching, and infield lessons for travel ball players.",
    about: "This is a preview of what your LessonSpot booking page would look like for softball. Real coaches use this same layout — they just swap in their own branding, lesson types, and hours.",
    bookerLabel: "Parent",
    attendeeLabel: "Player",
    contactEmail: "demo@lessonspot.app",
    contactLocation: "Greenwood, IN",
    lessonTypes: [
      { name: "30 Min Hitting Lesson", durationMin: 30, capacity: 1, isGroup: 0 },
      { name: "1 Hour Hitting + Tee Work", durationMin: 60, capacity: 1, isGroup: 0 },
      { name: "Pitching Lesson", durationMin: 60, capacity: 1, isGroup: 0 },
      { name: "Group Clinic (8U–12U)", durationMin: 90, capacity: 6, isGroup: 1 },
    ],
    categories: [
      { slug: "hitting", label: "Hitting" },
      { slug: "pitching", label: "Pitching" },
      { slug: "fielding", label: "Fielding" },
      { slug: "baserunning", label: "Baserunning" },
      { slug: "general", label: "General" },
    ],
  },
  {
    slug: "demo-tennis",
    name: "Northside Tennis Academy",
    sport: "tennis",
    primaryColor: "#16a34a",
    tagline: "Private and group tennis lessons — juniors to adults.",
    about: "This is a sample LessonSpot booking page for a tennis program. Swap in your own court schedule, coaching staff, and pricing in minutes.",
    bookerLabel: "Client",
    attendeeLabel: "Student",
    contactEmail: "demo@lessonspot.app",
    contactLocation: "Indianapolis, IN",
    lessonTypes: [
      { name: "30 Min Private Lesson", durationMin: 30, capacity: 1, isGroup: 0 },
      { name: "1 Hour Private Lesson", durationMin: 60, capacity: 1, isGroup: 0 },
      { name: "Semi-Private (2 students)", durationMin: 60, capacity: 2, isGroup: 1 },
      { name: "Adult Clinic", durationMin: 90, capacity: 8, isGroup: 1 },
    ],
    categories: [
      { slug: "stroke-mechanics", label: "Stroke mechanics" },
      { slug: "footwork", label: "Footwork" },
      { slug: "serve", label: "Serve" },
      { slug: "match-play", label: "Match play" },
      { slug: "general", label: "General" },
    ],
  },
  {
    slug: "demo-golf",
    name: "Fairway Golf Instruction",
    sport: "golf",
    primaryColor: "#15803d",
    tagline: "Swing analysis, short game, and on-course coaching.",
    about: "A sample LessonSpot booking page for a golf instructor. Players can book a slot at the range, the green, or out on the course.",
    bookerLabel: "Client",
    attendeeLabel: "",
    contactEmail: "demo@lessonspot.app",
    contactLocation: "Carmel, IN",
    lessonTypes: [
      { name: "30 Min Range Session", durationMin: 30, capacity: 1, isGroup: 0 },
      { name: "1 Hour Swing Lesson", durationMin: 60, capacity: 1, isGroup: 0 },
      { name: "Short Game Lesson", durationMin: 60, capacity: 1, isGroup: 0 },
      { name: "Playing Lesson (9 holes)", durationMin: 90, capacity: 1, isGroup: 0 },
    ],
    categories: [
      { slug: "driving", label: "Driving" },
      { slug: "irons", label: "Irons" },
      { slug: "short-game", label: "Short game" },
      { slug: "putting", label: "Putting" },
      { slug: "general", label: "General" },
    ],
  },
  {
    slug: "demo-music",
    name: "Westside Music Studio",
    sport: "piano",
    primaryColor: "#a855f7",
    tagline: "Piano, guitar, and voice lessons for all ages.",
    about: "This is a preview of LessonSpot for a music studio. Students book recurring weekly slots, and parents get email reminders the night before.",
    bookerLabel: "Parent",
    attendeeLabel: "Student",
    contactEmail: "demo@lessonspot.app",
    contactLocation: "Bloomington, IN",
    lessonTypes: [
      { name: "30 Min Piano Lesson", durationMin: 30, capacity: 1, isGroup: 0 },
      { name: "30 Min Guitar Lesson", durationMin: 30, capacity: 1, isGroup: 0 },
      { name: "30 Min Voice Lesson", durationMin: 30, capacity: 1, isGroup: 0 },
      { name: "Group Theory Class", durationMin: 60, capacity: 6, isGroup: 1 },
    ],
    categories: [
      { slug: "technique", label: "Technique" },
      { slug: "repertoire", label: "Repertoire" },
      { slug: "theory", label: "Theory" },
      { slug: "ear-training", label: "Ear training" },
      { slug: "general", label: "General" },
    ],
  },
  {
    slug: "demo-tutoring",
    name: "Lakeview Tutoring",
    sport: "tutoring",
    primaryColor: "#f59e0b",
    tagline: "Math, reading, and SAT/ACT prep for grades 3–12.",
    about: "A LessonSpot preview for an academic tutoring service. Tutors share weekly availability and parents book ahead of school deadlines.",
    bookerLabel: "Parent",
    attendeeLabel: "Student",
    contactEmail: "demo@lessonspot.app",
    contactLocation: "Fishers, IN",
    lessonTypes: [
      { name: "1 Hour Math Tutoring", durationMin: 60, capacity: 1, isGroup: 0 },
      { name: "1 Hour Reading Tutoring", durationMin: 60, capacity: 1, isGroup: 0 },
      { name: "SAT/ACT Prep (90 min)", durationMin: 90, capacity: 1, isGroup: 0 },
      { name: "Small Group Study Hall", durationMin: 60, capacity: 4, isGroup: 1 },
    ],
    categories: [
      { slug: "math", label: "Math" },
      { slug: "reading", label: "Reading" },
      { slug: "writing", label: "Writing" },
      { slug: "test-prep", label: "Test prep" },
      { slug: "general", label: "General" },
    ],
  },
  {
    slug: "demo-wrestling",
    name: "Indy Wrestling Club",
    sport: "wrestling",
    primaryColor: "#dc2626",
    tagline: "Youth and high-school wrestling training — technique to live go.",
    about: "This is a sample LessonSpot booking page for a wrestling club. Open mat, technique sessions, and private lessons all share one calendar.",
    bookerLabel: "Parent",
    attendeeLabel: "Wrestler",
    contactEmail: "demo@lessonspot.app",
    contactLocation: "Greenwood, IN",
    lessonTypes: [
      { name: "Private Technique Lesson", durationMin: 60, capacity: 1, isGroup: 0 },
      { name: "Youth Practice (8–12)", durationMin: 75, capacity: 14, isGroup: 1 },
      { name: "HS Practice", durationMin: 90, capacity: 20, isGroup: 1 },
      { name: "Open Mat", durationMin: 60, capacity: 20, isGroup: 1 },
    ],
    categories: [
      { slug: "takedowns", label: "Takedowns" },
      { slug: "top", label: "Top" },
      { slug: "bottom", label: "Bottom" },
      { slug: "conditioning", label: "Conditioning" },
      { slug: "general", label: "General" },
    ],
  },
];

// Mon–Sat evening availability (Mon=1..Sat=6). Sundays remain closed.
const DEMO_AVAILABILITY: Array<{ dow: number; start: string; end: string; mode: string }> = [
  { dow: 1, start: "16:00", end: "20:00", mode: "both" },
  { dow: 2, start: "16:00", end: "20:00", mode: "both" },
  { dow: 3, start: "16:00", end: "20:00", mode: "both" },
  { dow: 4, start: "16:00", end: "20:00", mode: "both" },
  { dow: 5, start: "16:00", end: "20:00", mode: "both" },
  { dow: 6, start: "09:00", end: "13:00", mode: "both" },
];

export function seedDemoTenants(): void {
  const sqlite = new Database(process.env.DB_PATH || "data.db");
  try {
    const findBySlug = sqlite.prepare(`SELECT id FROM tenants WHERE slug = ? LIMIT 1`);
    const insertTenant = sqlite.prepare(`
      INSERT INTO tenants (
        slug, name, custom_domain, timezone, active, sport,
        primary_color, logo_path, hero_path, tagline, about,
        contact_phone, contact_email, contact_location,
        booker_label, attendee_label, plan, trial_ends_at, created_at
      ) VALUES (
        ?, ?, NULL, 'America/Indiana/Indianapolis', 1, ?,
        ?, '', '', ?, ?,
        '', ?, ?,
        ?, ?, 'trial', ?, ?
      )
    `);
    const insertLessonType = sqlite.prepare(`
      INSERT INTO lesson_types (tenant_id, name, duration_min, capacity, is_group, active, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `);
    const insertCategory = sqlite.prepare(`
      INSERT INTO resource_categories (tenant_id, slug, label, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertAvailability = sqlite.prepare(`
      INSERT INTO availability (tenant_id, day_of_week, start_time, end_time, mode)
      VALUES (?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    // Demo tenants get a far-future "trial" so they never appear expired.
    const farFuture = now + 365 * 24 * 60 * 60 * 1000 * 10;

    let createdCount = 0;
    for (const demo of DEMO_TENANTS) {
      const existing = findBySlug.get(demo.slug) as { id: number } | undefined;
      if (existing) continue;

      const tx = sqlite.transaction(() => {
        const tenantResult = insertTenant.run(
          demo.slug,
          demo.name,
          demo.sport,
          demo.primaryColor,
          demo.tagline,
          demo.about,
          demo.contactEmail,
          demo.contactLocation,
          demo.bookerLabel,
          demo.attendeeLabel,
          farFuture,
          now,
        );
        const tenantId = Number(tenantResult.lastInsertRowid);

        demo.lessonTypes.forEach((lt, idx) => {
          insertLessonType.run(tenantId, lt.name, lt.durationMin, lt.capacity, lt.isGroup, idx + 1, now);
        });

        demo.categories.forEach((c, idx) => {
          insertCategory.run(tenantId, c.slug, c.label, idx, now);
        });

        for (const a of DEMO_AVAILABILITY) {
          insertAvailability.run(tenantId, a.dow, a.start, a.end, a.mode);
        }
      });

      try {
        tx();
        createdCount++;
        console.log(`[demo-seed] created ${demo.slug}`);
      } catch (err) {
        console.error(`[demo-seed] failed to create ${demo.slug}:`, err);
      }
    }

    if (createdCount > 0) {
      console.log(`[demo-seed] seeded ${createdCount} demo tenant(s)`);
    }
  } finally {
    sqlite.close();
  }
}
