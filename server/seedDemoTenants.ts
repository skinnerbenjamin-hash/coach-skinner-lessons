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
import { randomBytes, scryptSync } from "node:crypto";

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
    attendeeLabel: "Golfer",
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

    // Idempotent branding-only upsert.  We re-apply tenant-row fields
    // (labels, tagline, primary color, etc.) every boot so tweaks to the
    // DEMO_TENANTS table actually take effect on existing demo tenants.
    // Lesson types, categories, and availability are NOT re-seeded for
    // existing rows to avoid stomping on any test bookings tied to them.
    const updateBranding = sqlite.prepare(`
      UPDATE tenants SET
        name = ?, sport = ?, primary_color = ?, tagline = ?, about = ?,
        contact_email = ?, contact_location = ?,
        booker_label = ?, attendee_label = ?
      WHERE slug = ?
    `);

    let createdCount = 0;
    let updatedCount = 0;
    for (const demo of DEMO_TENANTS) {
      const existing = findBySlug.get(demo.slug) as { id: number } | undefined;
      if (existing) {
        // Refresh branding only.
        try {
          updateBranding.run(
            demo.name, demo.sport, demo.primaryColor, demo.tagline, demo.about,
            demo.contactEmail, demo.contactLocation,
            demo.bookerLabel, demo.attendeeLabel,
            demo.slug,
          );
          updatedCount++;
        } catch (err) {
          console.error(`[demo-seed] failed to refresh branding for ${demo.slug}:`, err);
        }
        continue;
      }

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

    if (createdCount > 0 || updatedCount > 0) {
      console.log(`[demo-seed] seeded ${createdCount} new, refreshed ${updatedCount} existing demo tenant(s)`);
    }

    // --- Demo-softball admin + sample content ---
    // Idempotently ensure demo-softball has an admin login the marketing-page
    // walkthrough video can use, plus a small set of profiles, bookings,
    // resources, and coaching notes so the admin tour looks alive.
    seedDemoSoftballContent(sqlite);
  } finally {
    sqlite.close();
  }
}

// Phone + password for the public demo-softball admin login.  These are
// intentionally public — anyone visiting the marketing site can poke around
// the demo admin without affecting real coach data.
const DEMO_SOFTBALL_ADMIN_PHONE = "5550000001";
const DEMO_SOFTBALL_ADMIN_PASSWORD = "demoaccess";

function hashPw(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}
function normalizePhone(p: string) {
  return (p || "").replace(/\D/g, "");
}

function seedDemoSoftballContent(sqlite: Database.Database) {
  const t = sqlite.prepare(`SELECT id FROM tenants WHERE slug = 'demo-softball' LIMIT 1`).get() as { id: number } | undefined;
  if (!t) return;
  const tenantId = t.id;
  const now = Date.now();

  // 1) Admin login (idempotent: skip if already present for this tenant)
  try {
    const cols = sqlite.prepare(`PRAGMA table_info(admin_users)`).all() as { name: string }[];
    const hasTenantCol = cols.some(c => c.name === "tenant_id");
    if (hasTenantCol) {
      const np = normalizePhone(DEMO_SOFTBALL_ADMIN_PHONE);
      const exists = sqlite.prepare(`SELECT id FROM admin_users WHERE tenant_id=? AND phone=? LIMIT 1`).get(tenantId, np);
      if (!exists) {
        const salt = randomBytes(16).toString("hex");
        const hash = hashPw(DEMO_SOFTBALL_ADMIN_PASSWORD, salt);
        sqlite.prepare(
          `INSERT INTO admin_users (tenant_id, phone, name, salt, hash, is_owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
        ).run(tenantId, np, "Demo Admin", salt, hash, now, now);
        console.log(`[demo-seed] created demo-softball admin (phone=${np})`);
      }
    }
  } catch (err) {
    console.error("[demo-seed] failed to seed demo-softball admin:", err);
  }

  // 2) Sample profiles (parents/players)
  const sampleProfiles = [
    { phone: "3175550101", parent: "Sarah Mitchell", player: "Emma Mitchell", email: "sarah.m@example.com", notes: "Age 12, 10U travel. Working on contact-to-the-opposite-field." },
    { phone: "3175550102", parent: "Mike Johnson", player: "Olivia Johnson", email: "mjohnson@example.com", notes: "Age 14, varsity. Pitcher — building rise ball." },
    { phone: "3175550103", parent: "Jessica Park", player: "Maya Park", email: "jpark@example.com", notes: "Age 10, 12U travel. Switch hitter — left side needs work." },
    { phone: "3175550104", parent: "Chris Davis", player: "Brooke Davis", email: "chris@example.com", notes: "Age 16, college recruit. Focus: timing on off-speed." },
    { phone: "3175550105", parent: "Amanda Lee", player: "Sophia Lee", email: "alee@example.com", notes: "Age 11, 12U rec. New to lessons — build confidence." },
  ];

  const hasProfilesTenantCol = (sqlite.prepare(`PRAGMA table_info(profiles)`).all() as { name: string }[])
    .some(c => c.name === "tenant_id");
  if (!hasProfilesTenantCol) return; // migrations haven't run yet

  const profileIds: number[] = [];
  const findProfile = sqlite.prepare(`SELECT id FROM profiles WHERE tenant_id=? AND phone=? LIMIT 1`);
  const insertProfile = sqlite.prepare(
    `INSERT INTO profiles (tenant_id, phone, email, parent_name, player_name, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const p of sampleProfiles) {
    const ex = findProfile.get(tenantId, p.phone) as { id: number } | undefined;
    if (ex) { profileIds.push(ex.id); continue; }
    try {
      const r = insertProfile.run(tenantId, p.phone, p.email, p.parent, p.player, p.notes, now);
      profileIds.push(Number(r.lastInsertRowid));
    } catch {}
  }

  // 3) Sample bookings spread across the next 14 days at 4-7pm slots.
  // Only seed if there are zero bookings already (idempotent).
  const hasBookingsTenantCol = (sqlite.prepare(`PRAGMA table_info(bookings)`).all() as { name: string }[])
    .some(c => c.name === "tenant_id");
  if (hasBookingsTenantCol && profileIds.length) {
    const bookingCount = sqlite.prepare(`SELECT COUNT(*) as c FROM bookings WHERE tenant_id=?`).get(tenantId) as { c: number };
    if (bookingCount.c === 0) {
      const today = new Date();
      const insertBooking = sqlite.prepare(
        `INSERT INTO bookings (tenant_id, start, profile_id, booking_group, created_at) VALUES (?, ?, ?, ?, ?)`
      );
      const slots = [
        { offset: 1, hour: 16, min: 0, profileIdx: 0 },
        { offset: 1, hour: 16, min: 30, profileIdx: 1 },
        { offset: 2, hour: 17, min: 0, profileIdx: 2 },
        { offset: 3, hour: 16, min: 30, profileIdx: 3 },
        { offset: 4, hour: 18, min: 0, profileIdx: 4 },
        { offset: 5, hour: 17, min: 0, profileIdx: 0 },
        { offset: 7, hour: 16, min: 0, profileIdx: 1 },
        { offset: 8, hour: 16, min: 30, profileIdx: 2 },
        { offset: 9, hour: 17, min: 30, profileIdx: 3 },
        { offset: 11, hour: 18, min: 0, profileIdx: 4 },
      ];
      for (const s of slots) {
        const d = new Date(today);
        d.setDate(d.getDate() + s.offset);
        const yy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const hh = String(s.hour).padStart(2, "0");
        const mi = String(s.min).padStart(2, "0");
        const startIso = `${yy}-${mm}-${dd}T${hh}:${mi}`;
        const group = `demo-${s.offset}-${s.hour}${s.min}`;
        try {
          insertBooking.run(tenantId, startIso, profileIds[s.profileIdx], group, now);
        } catch {}
      }
      console.log(`[demo-seed] seeded ${slots.length} sample bookings for demo-softball`);
    }
  }

  // 4) Sample resources (videos + drills + notes)
  const hasResourcesTenantCol = (sqlite.prepare(`PRAGMA table_info(resources)`).all() as { name: string }[])
    .some(c => c.name === "tenant_id");
  if (hasResourcesTenantCol) {
    const rCount = sqlite.prepare(`SELECT COUNT(*) as c FROM resources WHERE tenant_id=?`).get(tenantId) as { c: number };
    if (rCount.c === 0) {
      const insertResource = sqlite.prepare(
        `INSERT INTO resources (tenant_id, type, category, title, description, url, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, '', ?)`
      );
      const resources = [
        { type: "video", cat: "hitting", title: "Inside / outside pitch recognition", desc: "5-minute drill to train pitch location read on tee work.", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        { type: "video", cat: "hitting", title: "Tee work — swing path drill", desc: "Two-tee setup for high-low and inside-outside swing path.", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        { type: "video", cat: "pitching", title: "Drive leg explosion", desc: "Building hip-and-shoulder separation on the rubber.", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        { type: "link", cat: "hitting", title: "At-home tee setup checklist", desc: "Quick PDF on getting the tee height, angle, and ball placement right at home.", url: "https://example.com/tee-checklist" },
        { type: "link", cat: "general", title: "Pre-lesson warmup routine", desc: "10-minute dynamic warmup every player should run through before swinging.", url: "https://example.com/warmup" },
        { type: "video", cat: "fielding", title: "Infield footwork — forehand & backhand", desc: "Drill progression for clean glove work at SS and 2B.", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
      ];
      for (const r of resources) {
        try { insertResource.run(tenantId, r.type, r.cat, r.title, r.desc, r.url, now); } catch {}
      }
      console.log(`[demo-seed] seeded ${resources.length} resources for demo-softball`);
    }
  }

  // 5) Sample coaching notes (a private thread for first 3 players)
  const hasNotesTenantCol = (sqlite.prepare(`PRAGMA table_info(coaching_notes)`).all() as { name: string }[])
    .some(c => c.name === "tenant_id");
  if (hasNotesTenantCol && profileIds.length >= 3) {
    const nCount = sqlite.prepare(`SELECT COUNT(*) as c FROM coaching_notes WHERE tenant_id=?`).get(tenantId) as { c: number };
    if (nCount.c === 0) {
      const insertNote = sqlite.prepare(
        `INSERT INTO coaching_notes (tenant_id, profile_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)`
      );
      const notes = [
        { idx: 0, author: "coach", text: "Great session today. Emma’s contact point is much more out-front. Keep working the tee at home — inside pitch, three sets of 10." },
        { idx: 0, author: "parent", text: "Thanks! She loved it. We’ll get the tee out tomorrow." },
        { idx: 1, author: "coach", text: "Olivia’s rise ball is starting to break late. Need to keep the wrist firm at release — video link in resources." },
        { idx: 2, author: "coach", text: "Maya’s left-side swing looked great today. Plant foot is staying closed longer. Let’s build on this next session." },
      ];
      for (const n of notes) {
        try { insertNote.run(tenantId, profileIds[n.idx], n.author, n.text, now); } catch {}
      }
      console.log(`[demo-seed] seeded ${notes.length} coaching notes for demo-softball`);
    }
  }
}
