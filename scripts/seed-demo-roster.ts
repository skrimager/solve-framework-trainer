// One-off, idempotent roster and session-content backfill for the shared Demo
// Office (invite code DEMO2024, office #1). It intentionally never reads or
// writes any other office.
//
// Run against an approved database only:
//   DATABASE_URL=postgres://... npx tsx scripts/seed-demo-roster.ts
import { pathToFileURL } from "node:url";

import { storage } from "../server/storage";
import type { InsertCoachingMessage, InsertSession, Scenario, Session } from "@shared/schema";

function scenarioTrack(track: string | null | undefined): string {
  return track === "leadership" ? "leadership" : "consulting";
}

const DEMO_OFFICE_INVITE_CODE = "DEMO2024";
const DEMO_PASSWORD = "SolveDemo!2026";
export const DEMO_ROSTER_OFFICE_ID = 1;
export const CONSULTING_VERTICAL = "home_improvement";
const NOW = new Date();

type Level = "beginner" | "intermediate" | "advanced";
type TranscriptRole = "customer" | "consultant";
type CoachingRole = "trainee" | "coach";

export interface SessionSpec {
  level: Level;
  score: number;
  daysAgo: number;
}

export interface Persona {
  username: string;
  displayName: string;
  currentLevel: Level;
  consultingCertified?: boolean;
  consultingCertifiedDaysAgo?: number;
  stage: string;
  sessions: SessionSpec[];
}

interface TranscriptTurn {
  role: TranscriptRole;
  content: string;
  timestamp: string;
}

interface ExistingSessionContent {
  id: number;
  transcript: string;
}

export interface BackfillPlan {
  insertSessionCount: number;
  transcriptSessionIds: number[];
}

// The original six Demo Office personas show the complete journey from first
// attempts through certification. Scores and rubrics remain intentionally
// fabricated demo data.
export const DEMO_OFFICE_PERSONAS: Persona[] = [
  {
    username: "marcus.bell",
    displayName: "Marcus Bell",
    currentLevel: "beginner",
    stage: "Early beginner, just started, 0 of 5 qualifying",
    sessions: [
      { level: "beginner", score: 62, daysAgo: 9 },
      { level: "beginner", score: 71, daysAgo: 5 },
    ],
  },
  {
    username: "priya.nair",
    displayName: "Priya Nair",
    currentLevel: "beginner",
    stage: "Mid beginner, building momentum, 3 of 5 qualifying at beginner",
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
    stage: "Just advanced to intermediate, qualified at beginner, 1 of 5 at intermediate",
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
    stage: "Solid intermediate, consistent, 3 of 5 qualifying at intermediate",
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
    stage: "Advanced, near certification, 4 of 5 qualifying at advanced",
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
    stage: "Fully certified, full three-level journey, high overall average",
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

function timestamp(daysAgo: number, hourJitter: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(9 + (hourJitter % 8), (hourJitter * 7) % 60, 0, 0);
  return d.toISOString();
}

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
  keys.forEach((key, index) => {
    const value = score + offsets[(index + seed) % offsets.length] + ((seed + index) % 2 === 0 ? 1 : -1);
    rubric[key] = Math.max(1, Math.min(100, value));
  });
  return JSON.stringify(rubric);
}

function cleanGeneratedText(value: string): string {
  return value
    .replace(/[\u2013\u2014]/g, ",")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .trim();
}

function personaSource(scenario: Scenario): string {
  return scenario.personaCore || scenario.customerPersona || scenario.description;
}

function customerName(scenario: Scenario): string {
  const match = personaSource(scenario).match(/You are\s+([A-Za-z]+)/i);
  return match?.[1] ?? "the homeowner";
}

function openingFor(scenario: Scenario): string {
  const source = personaSource(scenario);
  const labeled = source.match(/opening stance:\s*["“]([^"”]+)["”]/i);
  const quoted = source.match(/["“]([^"”]+)["”]/);
  // A scenario title is an internal authoring label, not language a customer
  // would naturally repeat in conversation.
  return cleanGeneratedText(labeled?.[1] ?? quoted?.[1] ?? "I could use a better way to handle this.");
}

function underlyingNeedFor(scenario: Scenario): string {
  const source = personaSource(scenario);
  const bullet = source
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("-") && !/^-[^a-z]*(if |once |when )/i.test(line));
  if (bullet) return cleanGeneratedText(bullet.replace(/^-\s*/, ""));
  return cleanGeneratedText(scenario.description);
}

function objectionFor(scenario: Scenario): string {
  try {
    const values = JSON.parse(scenario.objectionPool) as unknown;
    if (Array.isArray(values) && typeof values[0] === "string") return cleanGeneratedText(values[0]);
  } catch {
    // Older scenario rows can have an empty or non-JSON objection pool.
  }
  return "I do not want to make a decision before I understand the approach.";
}

function turnTimestamps(completedAt: string | null, count: number): string[] {
  const end = completedAt ? new Date(completedAt) : new Date();
  const validEnd = Number.isNaN(end.getTime()) ? new Date() : end;
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(validEnd);
    at.setMinutes(at.getMinutes() - (count - 1 - index) * 4);
    return at.toISOString();
  });
}

function turnsWithTimestamps(contents: Array<[TranscriptRole, string]>, completedAt: string | null): TranscriptTurn[] {
  const timestamps = turnTimestamps(completedAt, contents.length);
  return contents.map(([role, content], index) => ({ role, content: cleanGeneratedText(content), timestamp: timestamps[index] }));
}

/** Builds score-calibrated transcript JSON from the actual persisted scenario context. */
export function buildTranscript(session: Pick<Session, "score" | "completedAt">, scenario: Scenario, seed: number): string {
  const score = session.score ?? 0;
  const name = customerName(scenario);
  const opening = openingFor(scenario);
  const need = underlyingNeedFor(scenario);
  const objection = objectionFor(scenario);
  const title = scenario.title;
  const discoveryQuestions = [
    "What has made this feel urgent now?",
    "When you picture this working better, what would be different in your day?",
    "Can you walk me through the moment the current situation becomes frustrating?",
    "What would you want to protect as we think through a better approach?",
  ];
  const reflections = [
    "It sounds like the stated request is only part of it. You want a result that fits how this affects you, not a rushed recommendation.",
    "I am hearing that the outcome matters more than simply checking off the first request. You want the process to address the disruption behind it.",
    "You are not looking for more activity around this. You want confidence that the next step solves the issue you are actually living with.",
    "The detail you just shared changes the conversation. The right direction has to work for the priority underneath the initial request.",
  ];
  const alternateQuestion = discoveryQuestions[seed % discoveryQuestions.length];
  const reflection = reflections[seed % reflections.length];

  if (score < 65) {
    return JSON.stringify(turnsWithTimestamps([
      ["customer", `I'm ${name}. ${opening}`],
      ["consultant", `We have a proven approach for this. I can walk you through the standard options and get this moving today.`],
      ["customer", `I was hoping you would ask a little more first. ${need}`],
      ["consultant", "I hear you, but the next step is choosing a direction. Most people in this situation start there."],
      ["customer", "That does not really address what I said. I need to think about whether this conversation is useful."],
      ["consultant", "Understood. I will send general information, and you can decide when you are ready."],
    ], session.completedAt));
  }

  if (score < 85) {
    return JSON.stringify(turnsWithTimestamps([
      ["customer", `I'm ${name}. ${opening}`],
      ["consultant", `Before I suggest a direction for ${title}, I want to understand the day-to-day situation. ${alternateQuestion}`],
      ["customer", need],
      ["consultant", reflection],
      ["customer", objection],
      ["consultant", "That makes sense. We can look at a direction that addresses what you described, then you can decide whether it feels right."],
      ["customer", "I appreciate that. I still want to be careful before I commit to anything."],
      ["consultant", "Fair. I will outline the possible next step, and we can reconnect after you have had time to consider it."],
    ], session.completedAt));
  }

  return JSON.stringify(turnsWithTimestamps([
    ["customer", `I'm ${name}. ${opening}`],
    ["consultant", `Before we discuss a direction for ${title}, I want to understand the day-to-day situation. ${alternateQuestion}`],
    ["customer", need],
    ["consultant", `${reflection} Did I capture that?`],
    ["customer", `Yes. My hesitation is this: ${objection}`],
    ["consultant", "That is reasonable. Rather than push you toward a decision, we can make the next conversation useful by focusing on the outcome you named and the questions you still need answered."],
    ["customer", "That would help. I do not want to repeat the same problem after putting time into this."],
    ["consultant", `Then let us use a short follow-up to review a direction for ${title} against the day-to-day need you described. I will bring the open questions into that review so nothing gets skipped.`],
    ["customer", "Yes, that gives me a clearer way to evaluate it. I can make time for that follow-up."],
    ["consultant", "I will send the focused next-step outline today, and we will use the follow-up to confirm the direction together."],
  ], session.completedAt));
}

function messageTime(completedAt: string | null, minutesAfter: number): string {
  const date = completedAt ? new Date(completedAt) : new Date();
  const base = Number.isNaN(date.getTime()) ? new Date() : date;
  base.setMinutes(base.getMinutes() + minutesAfter);
  return base.toISOString();
}

/** Builds a short, rubric-specific Q&A exchange that references the generated dialogue. */
export function buildCoachingMessages(
  session: Pick<Session, "id" | "userId" | "score" | "completedAt">,
  scenario: Scenario,
  seed: number,
): InsertCoachingMessage[] {
  const score = session.score ?? 0;
  const title = scenario.title;
  const need = underlyingNeedFor(scenario);
  const quotedNeed = need.replace(/[.?!]+$/, "");
  const discoveryQuestion = [
    "What has made this feel urgent now?",
    "When you picture this working better, what would be different in your day?",
    "Can you walk me through the moment the current situation becomes frustrating?",
    "What would you want to protect as we think through a better approach?",
  ][seed % 4];
  const messages: Array<{ role: CoachingRole; content: string; minutesAfter: number }> = [];

  if (score < 65) {
    messages.push(
      {
        role: "trainee",
        content: "Why did I lose ground so quickly after I offered the standard options?",
        minutesAfter: 12,
      },
      {
        role: "coach",
        content: `You moved to “the standard options” before learning why ${title} mattered to the customer. They gave you a clear opening with “${quotedNeed},” and you redirected instead of following it. That weakened needsDiscovery and trustBuilding. Try: “Before I suggest a direction, can you tell me more about what that has been like for you?”`,
        minutesAfter: 20,
      },
    );
  } else if (score < 85) {
    messages.push(
      {
        role: "trainee",
        content: "I reflected the concern, so why was the objection handling still only partial?",
        minutesAfter: 14,
      },
      {
        role: "coach",
        content: `Your reflection was useful, but after the customer said they wanted to be careful, you moved to a follow-up without testing what they still needed to understand. That left objectionPrevention incomplete. Try: “What would you need clarified in that follow-up to feel comfortable evaluating a direction?”`,
        minutesAfter: 23,
      },
    );
  } else {
    messages.push(
      {
        role: "trainee",
        content: "Which part of my discovery created the most trust in this conversation?",
        minutesAfter: 15,
      },
      {
        role: "coach",
        content: `The strongest move was asking “${discoveryQuestion}” and then reflecting that the visible request was not the full need. You tied the follow-up for ${title} to the day-to-day outcome the customer described. That supported needsDiscovery, trustBuilding, and a naturalClose because the customer agreed to a specific next step.`,
        minutesAfter: 27,
      },
      {
        role: "trainee",
        content: "How could I make that next step even tighter without sounding pushy?",
        minutesAfter: 48 + (seed % 3) * 7,
      },
      {
        role: "coach",
        content: "Keep the customer in control of the agenda. You could say: “I will bring the questions you want answered, and we can use the follow-up to decide whether this direction fits.” That strengthens relationshipContinuity while preserving the collaborative tone you established.",
        minutesAfter: 58 + (seed % 3) * 7,
      },
    );
  }

  return messages.map((message) => ({
    sessionId: session.id,
    userId: session.userId,
    role: message.role,
    content: cleanGeneratedText(message.content),
    cleared: false,
    createdAt: messageTime(session.completedAt, message.minutesAfter),
  }));
}

export function transcriptNeedsBackfill(transcript: string | null | undefined): boolean {
  if (!transcript) return true;
  try {
    const parsed = JSON.parse(transcript) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return true;
    // Some early demo rows used a one-turn placeholder rather than an empty
    // array. Treat those exactly like an empty transcript so every roster
    // session receives a complete, manager-readable conversation.
    return parsed.every((turn) => {
      if (!turn || typeof turn !== "object") return false;
      const content = (turn as { content?: unknown }).content;
      return typeof content === "string" && /placeholder|no transcript|not available/i.test(content);
    });
  } catch {
    return true;
  }
}

/** Pure reconciliation rule used by the script and unit tests. */
export function planSessionBackfill(existing: ExistingSessionContent[], desiredSessionCount: number): BackfillPlan {
  if (existing.length === 0) return { insertSessionCount: desiredSessionCount, transcriptSessionIds: [] };
  return {
    insertSessionCount: 0,
    transcriptSessionIds: existing.filter((session) => transcriptNeedsBackfill(session.transcript)).map((session) => session.id),
  };
}

function scenarioPools(allScenarios: Scenario[]): Record<Level, Scenario[]> {
  const pools: Record<Level, Scenario[]> = { beginner: [], intermediate: [], advanced: [] };
  for (const scenario of allScenarios) {
    if (scenarioTrack(scenario.track) !== "consulting") continue;
    if (scenario.vertical !== CONSULTING_VERTICAL) continue;
    if (scenario.difficulty in pools) pools[scenario.difficulty as Level].push(scenario);
  }
  for (const level of ["beginner", "intermediate", "advanced"] as Level[]) {
    if (pools[level].length === 0) {
      throw new Error(`No ${CONSULTING_VERTICAL} consulting scenarios found at difficulty "${level}".`);
    }
    pools[level].sort((a, b) => a.id - b.id);
  }
  return pools;
}

async function addCoachingIfMissing(session: Session, scenario: Scenario, seed: number): Promise<number> {
  const existingMessages = await storage.listCoachingMessagesBySession(session.id);
  if (existingMessages.length > 0) return 0;
  const messages = buildCoachingMessages(session, scenario, seed);
  for (const message of messages) await storage.createCoachingMessage(message);
  return messages.length;
}

async function backfillPersona(
  persona: Persona,
  officeId: number,
  allowUserCreate: boolean,
  pools: Record<Level, Scenario[]>,
  scenariosById: Map<number, Scenario>,
): Promise<{ usersCreated: number; sessionsCreated: number; transcriptsUpdated: number; coachingCreated: number }> {
  let user = await storage.getUserByUsername(persona.username);
  let usersCreated = 0;
  if (!user) {
    if (!allowUserCreate) {
      throw new Error(`Expected existing Demo Office account ${persona.username} was not found.`);
    }
    user = await storage.createUser({
      officeId,
      username: persona.username,
      password: DEMO_PASSWORD,
      role: "consultant",
      displayName: persona.displayName,
      currentLevel: persona.currentLevel,
      seatActive: true,
      isDemoAccount: true,
      consultingCertified: persona.consultingCertified ?? false,
      consultingCertifiedAt:
        persona.consultingCertified && persona.consultingCertifiedDaysAgo != null
          ? timestamp(persona.consultingCertifiedDaysAgo, 5)
          : null,
    });
    usersCreated = 1;
    console.log(`+ user  ${persona.username.padEnd(18)} [${persona.stage}]`);
  } else if (user.officeId !== officeId) {
    throw new Error(`${persona.username} belongs to office #${user.officeId}, not expected office #${officeId}.`);
  } else {
    console.log(`= user  ${persona.username.padEnd(18)} already exists`);
  }

  const existing = (await storage.listSessionsByUser(user.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const plan = planSessionBackfill(existing, persona.sessions.length);
  let sessionsCreated = 0;
  let transcriptsUpdated = 0;
  let coachingCreated = 0;

  if (plan.insertSessionCount > 0) {
    const cursor: Record<Level, number> = { beginner: 0, intermediate: 0, advanced: 0 };
    for (let seed = 0; seed < persona.sessions.length; seed++) {
      const spec = persona.sessions[seed];
      const pool = pools[spec.level];
      const scenario = pool[cursor[spec.level] % pool.length];
      cursor[spec.level]++;
      const completedAt = timestamp(spec.daysAgo, seed);
      const draft: InsertSession = {
        userId: user.id,
        scenarioId: scenario.id,
        status: "completed",
        transcript: "[]",
        score: spec.score,
        rubricScores: rubricFor(spec.score, seed),
        feedback: `Practice attempt on "${scenario.title}", overall ${spec.score}.`,
        createdAt: completedAt,
        completedAt,
      };
      draft.transcript = buildTranscript(
        { score: draft.score ?? null, completedAt: draft.completedAt ?? null },
        scenario,
        seed,
      );
      const created = await storage.createSession(draft);
      sessionsCreated++;
      coachingCreated += await addCoachingIfMissing(created, scenario, seed);
    }
    console.log(`  + ${sessionsCreated} session(s) inserted with transcript and coaching content`);
  } else {
    for (let seed = 0; seed < existing.length; seed++) {
      const session = existing[seed];
      const scenario = scenariosById.get(session.scenarioId);
      if (!scenario) {
        console.warn(`  ! session #${session.id} references missing scenario #${session.scenarioId}; skipped`);
        continue;
      }
      if (plan.transcriptSessionIds.includes(session.id)) {
        await storage.updateSession(session.id, { transcript: buildTranscript(session, scenario, seed) });
        transcriptsUpdated++;
      }
      coachingCreated += await addCoachingIfMissing(session, scenario, seed);
    }
    console.log(`  = ${existing.length} existing session(s), ${transcriptsUpdated} transcript(s) backfilled, ${coachingCreated} coaching message(s) added`);
  }

  return { usersCreated, sessionsCreated, transcriptsUpdated, coachingCreated };
}

async function main() {
  const demoOffice = await storage.getOfficeByInviteCode(DEMO_OFFICE_INVITE_CODE);
  if (!demoOffice) {
    throw new Error(`Demo Office (invite code ${DEMO_OFFICE_INVITE_CODE}) not found. Run the app once, then rerun this approved backfill.`);
  }
  if (demoOffice.id !== DEMO_ROSTER_OFFICE_ID) {
    throw new Error(`Invite code ${DEMO_OFFICE_INVITE_CODE} resolved to office #${demoOffice.id}, not the protected Demo Office #${DEMO_ROSTER_OFFICE_ID}.`);
  }

  const allScenarios = await storage.listScenarios();
  const pools = scenarioPools(allScenarios);
  const scenariosById = new Map(allScenarios.map((scenario) => [scenario.id, scenario]));
  const totals = { usersCreated: 0, sessionsCreated: 0, transcriptsUpdated: 0, coachingCreated: 0 };

  for (const persona of DEMO_OFFICE_PERSONAS) {
    const result = await backfillPersona(persona, demoOffice.id, true, pools, scenariosById);
    totals.usersCreated += result.usersCreated;
    totals.sessionsCreated += result.sessionsCreated;
    totals.transcriptsUpdated += result.transcriptsUpdated;
    totals.coachingCreated += result.coachingCreated;
  }

  console.log(`\nDone. Created ${totals.usersCreated} user(s), ${totals.sessionsCreated} session(s), updated ${totals.transcriptsUpdated} transcript(s), and inserted ${totals.coachingCreated} coaching message(s).`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
