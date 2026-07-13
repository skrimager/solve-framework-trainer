// One-off, idempotent script that populates the shared "Demo Office" (invite code
// DEMO2024) with a believable, varied consultant roster for sales-pitch demos.
//
// Production today has a single real consultant ("Consultant Demo"). A live demo
// of the manager dashboard's "Consultant roster" looks bare with one row, so this
// inserts 6 ADDITIONAL fabricated consultants — each with a hand-built session
// history — so the roster tells a realistic team-progression story (early
// beginner → certified) across the qualifying-session and certification stages a
// real manager would actually see.
//
// Everything is inserted directly (no AI grading): scores/rubrics are fabricated.
// It reuses storage.createUser / storage.createSession so passwords and every
// required column go through the same path the app uses (regular-user passwords
// are stored as-is — only admin accounts are hashed, see server/admin.ts).
//
// IDEMPOTENT: consultants are keyed by username. A persona whose username already
// exists is not recreated; its sessions are only inserted if it has none yet, so
// a re-run (or a resumed partial run) never produces duplicates.
//
// Run against whatever DATABASE_URL points at:
//   DATABASE_URL=postgres://... npx tsx scripts/seed-demo-roster.ts
//
import { storage } from "../server/storage";
import type { InsertSession, Scenario } from "@shared/schema";

// Normalizes a scenario's track (rows predating the track column read as
// consulting). Inlined from server/llm.ts to avoid importing that module, which
// eagerly constructs an OpenAI client and would force this data-only script to
// require an OPENAI_API_KEY it never uses.
function scenarioTrack(track: string | null | undefined): string {
  return track === "leadership" ? "leadership" : "consulting";
}

const DEMO_OFFICE_INVITE_CODE = "DEMO2024";
const DEMO_PASSWORD = "SolveDemo!2026"; // shared demo login; regular-user passwords are plaintext
const CONSULTING_VERTICAL = "home_improvement"; // the only vertical with real, joinable scenario content

// "Now" anchor. Dates are expressed as whole days before this so "last active"
// spreads organically over the past several weeks instead of a single batch day.
const NOW = new Date();

type Level = "beginner" | "intermediate" | "advanced";

// One fabricated practice attempt. `daysAgo` places it in the past; a few extra
// hours of jitter are added per session so timestamps never share an exact time.
interface SessionSpec {
  level: Level;
  score: number;
  daysAgo: number;
}

interface Persona {
  username: string;
  displayName: string;
  currentLevel: Level;
  consultingCertified?: boolean;
  consultingCertifiedDaysAgo?: number; // when set (with consultingCertified), stamps consultingCertifiedAt
  stage: string; // human-readable description of the designed stage, for logging
  sessions: SessionSpec[];
}

// ── The 6 personas, spread across realistic stages ──────────────────────────
// Scores carry natural variance (no suspiciously round repetition). Qualifying =
// sessions at the consultant's CURRENT level scoring >= 85 (server/llm.ts
// ADVANCE_THRESHOLD=85, REQUIRED_QUALIFYING_SESSIONS=5). Sessions at a lower
// level than the consultant's current one reflect the journey that got them
// there and do NOT count toward the current tier's "N of 5".
const PERSONAS: Persona[] = [
  {
    username: "marcus.bell",
    displayName: "Marcus Bell",
    currentLevel: "beginner",
    stage: "Early beginner — just started, 0 of 5 qualifying",
    sessions: [
      { level: "beginner", score: 62, daysAgo: 9 },
      { level: "beginner", score: 71, daysAgo: 5 },
    ],
  },
  {
    username: "priya.nair",
    displayName: "Priya Nair",
    currentLevel: "beginner",
    stage: "Mid beginner — building momentum, 3 of 5 qualifying at beginner",
    sessions: [
      { level: "beginner", score: 74, daysAgo: 22 },
      { level: "beginner", score: 88, daysAgo: 16 },
      { level: "beginner", score: 86, daysAgo: 10 },
      { level: "beginner", score: 91, daysAgo: 4 },
    ],
  },
  {
    username: "diego.ramirez",
    displayName: "Diego Ramirez",
    currentLevel: "intermediate",
    stage: "Just advanced to intermediate — qualified at beginner, 1 of 5 at intermediate",
    sessions: [
      { level: "beginner", score: 87, daysAgo: 40 },
      { level: "beginner", score: 85, daysAgo: 37 },
      { level: "beginner", score: 90, daysAgo: 33 },
      { level: "beginner", score: 86, daysAgo: 30 },
      { level: "beginner", score: 89, daysAgo: 27 },
      { level: "intermediate", score: 79, daysAgo: 8 },
      { level: "intermediate", score: 88, daysAgo: 3 },
    ],
  },
  {
    username: "hannah.cole",
    displayName: "Hannah Cole",
    currentLevel: "intermediate",
    stage: "Solid intermediate — consistent, 3 of 5 qualifying at intermediate",
    sessions: [
      { level: "beginner", score: 86, daysAgo: 55 },
      { level: "beginner", score: 88, daysAgo: 52 },
      { level: "beginner", score: 91, daysAgo: 49 },
      { level: "beginner", score: 85, daysAgo: 46 },
      { level: "beginner", score: 90, daysAgo: 43 },
      { level: "intermediate", score: 89, daysAgo: 20 },
      { level: "intermediate", score: 82, daysAgo: 16 },
      { level: "intermediate", score: 91, daysAgo: 12 },
      { level: "intermediate", score: 86, daysAgo: 7 },
      { level: "intermediate", score: 80, daysAgo: 2 },
    ],
  },
  {
    username: "trevor.osei",
    displayName: "Trevor Osei",
    currentLevel: "advanced",
    stage: "Advanced, near certification — 4 of 5 qualifying at advanced, not yet certified",
    sessions: [
      { level: "beginner", score: 87, daysAgo: 56 },
      { level: "beginner", score: 90, daysAgo: 53 },
      { level: "beginner", score: 86, daysAgo: 50 },
      { level: "beginner", score: 92, daysAgo: 47 },
      { level: "beginner", score: 88, daysAgo: 44 },
      { level: "intermediate", score: 89, daysAgo: 41 },
      { level: "intermediate", score: 86, daysAgo: 38 },
      { level: "intermediate", score: 90, daysAgo: 34 },
      { level: "intermediate", score: 85, daysAgo: 31 },
      { level: "intermediate", score: 93, daysAgo: 28 },
      { level: "advanced", score: 88, daysAgo: 22 },
      { level: "advanced", score: 92, daysAgo: 17 },
      { level: "advanced", score: 90, daysAgo: 12 },
      { level: "advanced", score: 83, daysAgo: 6 },
      { level: "advanced", score: 86, daysAgo: 2 },
    ],
  },
  {
    username: "sofia.castellano",
    displayName: "Sofia Castellano",
    currentLevel: "advanced",
    consultingCertified: true,
    consultingCertifiedDaysAgo: 10,
    stage: "Fully certified — full 3-tier journey, high overall average",
    sessions: [
      { level: "beginner", score: 88, daysAgo: 58 },
      { level: "beginner", score: 91, daysAgo: 55 },
      { level: "beginner", score: 86, daysAgo: 52 },
      { level: "beginner", score: 93, daysAgo: 49 },
      { level: "beginner", score: 89, daysAgo: 46 },
      { level: "intermediate", score: 90, daysAgo: 42 },
      { level: "intermediate", score: 87, daysAgo: 39 },
      { level: "intermediate", score: 92, daysAgo: 35 },
      { level: "intermediate", score: 88, daysAgo: 31 },
      { level: "intermediate", score: 94, daysAgo: 27 },
      { level: "advanced", score: 90, daysAgo: 22 },
      { level: "advanced", score: 93, daysAgo: 19 },
      { level: "advanced", score: 88, daysAgo: 16 },
      { level: "advanced", score: 79, daysAgo: 14 },
      { level: "advanced", score: 91, daysAgo: 13 },
      { level: "advanced", score: 87, daysAgo: 12 },
    ],
  },
];

// ISO timestamp `daysAgo` days before NOW, nudged by a per-session hour offset so
// no two fabricated sessions collide on the exact same instant.
function timestamp(daysAgo: number, hourJitter: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(9 + (hourJitter % 8), (hourJitter * 7) % 60, 0, 0);
  return d.toISOString();
}

// Fabricated per-dimension rubric that averages near the overall score, with
// small fixed per-dimension offsets so it reads as human, not uniform.
function rubricFor(score: number, seed: number): string {
  const offsets = [3, -4, 1, -2, 2];
  const keys = [
    "needsDiscovery",
    "objectionPrevention",
    "trustBuilding",
    "naturalClose",
    "relationshipContinuity",
  ] as const;
  const rubric: Record<string, number> = {};
  keys.forEach((k, i) => {
    const v = score + offsets[(i + seed) % offsets.length] + ((seed + i) % 2 === 0 ? 1 : -1);
    rubric[k] = Math.max(1, Math.min(100, v));
  });
  return JSON.stringify(rubric);
}

async function main() {
  const office = await storage.getOfficeByInviteCode(DEMO_OFFICE_INVITE_CODE);
  if (!office) {
    throw new Error(
      `Demo Office (invite code ${DEMO_OFFICE_INVITE_CODE}) not found. Run the app once so migrations/seed create it, then re-run this script.`,
    );
  }

  // Build per-difficulty pools of REAL consulting scenarios so fabricated sessions
  // reference rows that actually exist (the roster detail view joins on scenarioId
  // to show the scenario title — an invented id would break that join).
  const allScenarios = await storage.listScenarios();
  const pools: Record<Level, Scenario[]> = { beginner: [], intermediate: [], advanced: [] };
  for (const s of allScenarios) {
    if (scenarioTrack(s.track) !== "consulting") continue;
    if (s.vertical !== CONSULTING_VERTICAL) continue;
    if (s.difficulty in pools) pools[s.difficulty as Level].push(s);
  }
  for (const level of ["beginner", "intermediate", "advanced"] as Level[]) {
    if (pools[level].length === 0) {
      throw new Error(`No ${CONSULTING_VERTICAL} consulting scenarios found at difficulty "${level}". Cannot build a believable roster.`);
    }
    pools[level].sort((a, b) => a.id - b.id); // stable ordering so re-runs pick the same scenarios
  }

  let createdUsers = 0;
  let createdSessions = 0;

  for (const persona of PERSONAS) {
    let user = await storage.getUserByUsername(persona.username);
    if (!user) {
      user = await storage.createUser({
        officeId: office.id,
        username: persona.username,
        password: DEMO_PASSWORD,
        role: "consultant",
        displayName: persona.displayName,
        currentLevel: persona.currentLevel,
        // Mirror the existing "Consultant Demo": a permanently-free demo seat that
        // never touches Stripe seat billing or the office seat count.
        seatActive: true,
        isDemoAccount: true,
        consultingCertified: persona.consultingCertified ?? false,
        consultingCertifiedAt:
          persona.consultingCertified && persona.consultingCertifiedDaysAgo != null
            ? timestamp(persona.consultingCertifiedDaysAgo, 5)
            : null,
      });
      createdUsers++;
      console.log(`+ user  ${persona.username.padEnd(18)} [${persona.stage}]`);
    } else {
      console.log(`= user  ${persona.username.padEnd(18)} already exists — skipping create`);
    }

    // Only insert sessions if this consultant has none — makes a resumed partial
    // run self-heal without ever duplicating history.
    const existing = await storage.listSessionsByUser(user.id);
    if (existing.length > 0) {
      console.log(`  = ${existing.length} session(s) already present — skipping session insert`);
      continue;
    }

    // Cycle through each level's scenario pool so a consultant's history references
    // varied real scenarios rather than the same one repeatedly.
    const cursor: Record<Level, number> = { beginner: 0, intermediate: 0, advanced: 0 };
    let seed = 0;
    for (const spec of persona.sessions) {
      const pool = pools[spec.level];
      const scenario = pool[cursor[spec.level] % pool.length];
      cursor[spec.level]++;
      const ts = timestamp(spec.daysAgo, seed);
      const session: InsertSession = {
        userId: user.id,
        scenarioId: scenario.id,
        status: "completed",
        transcript: "[]",
        score: spec.score,
        rubricScores: rubricFor(spec.score, seed),
        feedback: `Practice attempt on "${scenario.title}" — overall ${spec.score}.`,
        createdAt: ts,
        completedAt: ts,
      };
      await storage.createSession(session);
      createdSessions++;
      seed++;
    }
    console.log(`  + ${persona.sessions.length} session(s) inserted`);
  }

  console.log(
    `\nDone. Created ${createdUsers} new consultant(s) and ${createdSessions} session(s) in "${office.name}" (office #${office.id}).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
