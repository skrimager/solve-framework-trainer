import { buildTeamHealthInsightsDrilldown } from "./routes";

/**
 * Public, fictional data for the OTP-gated Command Center demonstration.
 * This is intentionally isolated from real office records: the public demo is
 * illustrative only and never reads or mutates customer data.
 */
const ISO = {
  now: "2026-08-15T18:20:00.000Z",
  recent: "2026-08-14T16:30:00.000Z",
  earlier: "2026-08-11T14:15:00.000Z",
};

const consultants = [
  { id: 101, displayName: "Maya Chen", currentLevel: "advanced", consultingCertified: true, totalSessionsCompleted: 42, averageScore: 94, lastSessionDate: ISO.recent },
  { id: 102, displayName: "Jordan Reyes", currentLevel: "advanced", consultingCertified: true, totalSessionsCompleted: 37, averageScore: 91, lastSessionDate: "2026-08-13T15:10:00.000Z" },
  { id: 103, displayName: "Priya Patel", currentLevel: "intermediate", consultingCertified: true, totalSessionsCompleted: 29, averageScore: 88, lastSessionDate: ISO.earlier },
  { id: 104, displayName: "Evan Brooks", currentLevel: "intermediate", consultingCertified: false, totalSessionsCompleted: 21, averageScore: 82, lastSessionDate: "2026-08-12T17:45:00.000Z" },
  { id: 105, displayName: "Tasha Morgan", currentLevel: "beginner", consultingCertified: false, totalSessionsCompleted: 14, averageScore: 76, lastSessionDate: "2026-07-27T12:00:00.000Z" },
  { id: 106, displayName: "Noah Kim", currentLevel: "beginner", consultingCertified: false, totalSessionsCompleted: 11, averageScore: 73, lastSessionDate: "2026-07-19T10:30:00.000Z" },
].map((consultant, index) => ({
  ...consultant,
  username: consultant.displayName.toLowerCase().replace(/\s+/g, "."),
  leadershipLevel: "beginner",
  consultingCertifiedAt: consultant.consultingCertified ? `2026-08-0${index + 2}T15:00:00.000Z` : null,
  leadershipCertified: false,
  leadershipCertifiedAt: null,
  qualifyingSessionsAtCurrentTier: consultant.consultingCertified ? 5 : [4, 2, 1][index % 3],
  requiredQualifyingSessions: 5,
  realConversationsThisMonth: [8, 6, 5, 4, 2, 1][index],
  realConversationCap: 10,
  industries: {
    consulting: { started: [{ vertical: "home_improvement", level: consultant.currentLevel, certified: consultant.consultingCertified }], certifiedCount: consultant.consultingCertified ? 1 : 0 },
    leadership: { started: [], certifiedCount: 0 },
  },
  academyLevel: consultant.consultingCertified ? 2 : 1,
  academyRankLabel: consultant.consultingCertified ? "Discovery Certified" : "Building Foundations",
  academyCreditCents: consultant.consultingCertified ? 15000 : 7500,
}));

const sessionInfo = [
  { id: 501, consultantId: 101, score: 96, title: "Homeowner Renovation Discovery", completedAt: ISO.recent },
  { id: 502, consultantId: 102, score: 92, title: "Commercial Service Renewal", completedAt: "2026-08-13T15:10:00.000Z" },
  { id: 503, consultantId: 103, score: 88, title: "Kitchen Upgrade Consultation", completedAt: ISO.earlier },
  { id: 504, consultantId: 104, score: 82, title: "Exterior Project Discovery", completedAt: "2026-08-12T17:45:00.000Z" },
  { id: 505, consultantId: 105, score: 76, title: "Bathroom Remodel Planning", completedAt: "2026-08-08T13:20:00.000Z" },
  { id: 506, consultantId: 106, score: 73, title: "Whole-home Assessment", completedAt: "2026-08-06T11:40:00.000Z" },
];

function detailForSession(session: (typeof sessionInfo)[number]) {
  const consultant = consultants.find((c) => c.id === session.consultantId)!;
  return {
    id: session.id,
    consultantId: consultant.id,
    consultantName: consultant.displayName,
    scenarioTitle: session.title,
    vertical: "home_improvement",
    status: "completed",
    score: session.score,
    rubricScores: { needsDiscovery: session.score - 2, objectionPrevention: session.score - 6, trustBuilding: session.score - 1, naturalClose: session.score - 4, relationshipContinuity: session.score - 3 },
    feedback: "Strong diagnosis-led discovery. Keep expanding the consequence questions before presenting the recommendation.",
    createdAt: session.completedAt,
    completedAt: session.completedAt,
    transcript: [
      { role: "consultant" as const, content: "Before we discuss options, what would a successful project change for you?", timestamp: session.completedAt },
      { role: "customer" as const, content: "We need the space to work for our family without creating another disruption next year.", timestamp: session.completedAt },
    ],
    coachingMessages: [{ id: session.id * 10, role: "coach" as const, content: "You connected the project to the customer's long-term decision criteria.", createdAt: session.completedAt }],
  };
}

const sessionDetails = Object.fromEntries(sessionInfo.map((session) => [session.id, detailForSession(session)]));
const details = Object.fromEntries(consultants.map((consultant) => {
  const primary = sessionInfo.find((session) => session.consultantId === consultant.id)!;
  return [consultant.id, {
    consultant,
    sessions: [
      { id: primary.id, scenarioTitle: primary.title, scenarioVertical: "home_improvement", track: "consulting", status: "completed", score: primary.score, rubricScores: sessionDetails[primary.id].rubricScores, createdAt: primary.completedAt, completedAt: primary.completedAt },
    ],
  }];
}));

const scoreBands = {
  "0-59": { band: "0-59", sessions: [] },
  "60-69": { band: "60-69", sessions: [] },
  "70-79": { band: "70-79", sessions: [sessionInfo[4], sessionInfo[5]] },
  "80-89": { band: "80-89", sessions: [sessionInfo[2], sessionInfo[3]] },
  "90-100": { band: "90-100", sessions: [sessionInfo[0], sessionInfo[1]] },
};
const scoreDistribution = Object.fromEntries(Object.entries(scoreBands).map(([band, data]) => [band, {
  band,
  sessions: data.sessions.map((session) => ({ sessionId: session.id, consultantName: consultants.find((c) => c.id === session.consultantId)!.displayName, scenarioTitle: session.title, score: session.score, completedAt: session.completedAt })),
}]));

const performers = Object.fromEntries(consultants.slice(0, 5).map((consultant) => {
  const sessions = sessionInfo.filter((session) => session.consultantId === consultant.id).map((session) => ({ sessionId: session.id, scenarioTitle: session.title, score: session.score, completedAt: session.completedAt }));
  return [consultant.id, { consultantId: consultant.id, consultantName: consultant.displayName, averageScore: consultant.averageScore, sessionCount: sessions.length, scoreSum: sessions.reduce((sum, session) => sum + session.score, 0), sessions }];
}));

// The demo uses the same pure Command Center builder as the live manager
// dashboard. These are the fixture's completed consulting sessions, shaped
// only to the fields the builder reads, not a second hardcoded insight list.
const demoInsightUsers = consultants.map((consultant) => ({
  id: consultant.id,
  displayName: consultant.displayName,
  role: "consultant",
}));
const demoInsightScenarios = [{ id: 1, track: "consulting" }];
const demoInsightSessions = sessionInfo.map((session) => ({
  id: session.id,
  userId: session.consultantId,
  scenarioId: 1,
  status: "completed",
  score: session.score,
  completedAt: session.completedAt,
  rubricScores: JSON.stringify(sessionDetails[session.id].rubricScores),
}));
const demoInsightPeriod = {
  since: new Date("2026-07-16T00:00:00.000Z"),
  until: new Date(ISO.now),
  days: 30,
  label: "Last 30 days",
};

const widgetConfig = Object.fromEntries([
  "teamHealth", "conversations", "completionRate", "certifications", "alerts", "liveFeed", "performanceOverTime", "skillRadar", "topPerformers", "conversationOutcomes", "scoreDistribution", "achievements", "popularScenarios", "ctaPanel", "summaryStrip",
].map((key) => [key, true]));

export function buildAcmeDemoDashboardPayload() {
  return {
    office: { name: "Acme Sales", inviteCode: "DEMO", subscriptionStatus: "active" },
    // Keep the prior response shape for current clients while adding the full
    // Command Center payload below.
    stats: { completed: 154, avgScore: 84, inProgress: 7 },
    consultants,
    details,
    commandCenter: {
      stats: {
        period: { label: "Last 30 days", days: 30, since: "2026-07-16T00:00:00.000Z", until: ISO.now },
        earliestSessionAt: "2026-02-02T10:00:00.000Z",
        kpis: { teamAverageScore: 84, practiceSessionsThisPeriod: 68, certificationsEarned: 3, activeConsultants: 6, consultantCount: 6 },
        scoreOverTime: [{ date: "2026-07-22", averageScore: 79, sessions: 7 }, { date: "2026-07-29", averageScore: 82, sessions: 11 }, { date: "2026-08-05", averageScore: 84, sessions: 16 }, { date: "2026-08-12", averageScore: 87, sessions: 18 }],
        discoveryDimensions: [
          { key: "needsDiscovery", label: "Needs Discovery", average: 89 }, { key: "objectionPrevention", label: "Objection Prevention", average: 78 }, { key: "trustBuilding", label: "Trust Building", average: 87 }, { key: "naturalClose", label: "Natural Close", average: 81 }, { key: "relationshipContinuity", label: "Relationship Continuity", average: 84 },
        ],
        leaderboard: consultants.map((consultant) => ({ id: consultant.id, displayName: consultant.displayName, averageScore: consultant.averageScore, sessionsCompleted: consultant.totalSessionsCompleted, tier: consultant.currentLevel })),
        levelDistribution: [{ tier: "beginner", count: 2 }, { tier: "intermediate", count: 2 }, { tier: "advanced", count: 2 }],
        verticalBreakdown: [{ vertical: "home_improvement", count: 52 }, { vertical: "auto_sales", count: 16 }],
        streaksAndRankings: consultants.map((consultant, index) => ({ id: consultant.id, displayName: consultant.displayName, streak: [8, 6, 5, 3, 1, 0][index], rank: index + 1, outOf: 6 })),
        totals: { completed: 154, inProgress: 7 },
        academyCredits: { totalCents: 75000, availableCents: 75000, display: "$750.00" },
      },
      extras: {
        teamHealth: { score: 86, deltaPercent: 9 },
        conversations: { count: 68, deltaPercent: 21, sparkline: [4, 7, 6, 9, 8, 11, 12] },
        completionRate: { percent: 91, deltaPercent: 6 },
        certifications: { count: 3, deltaPercent: 50 },
        alerts: [{ id: 105, displayName: "Tasha Morgan", reasons: ["lowScore"] }, { id: 106, displayName: "Noah Kim", reasons: ["inactive"] }],
        liveFeed: sessionInfo.slice(0, 5).map((session) => ({ id: `demo-${session.id}`, type: session.score >= 90 ? "high_score" as const : "session_completed" as const, userId: session.consultantId, displayName: consultants.find((c) => c.id === session.consultantId)!.displayName, detail: session.score >= 90 ? `Scored ${session.score} on ${session.title}` : `Completed ${session.title}`, occurredAt: session.completedAt, sessionId: session.id })),
        performanceOverTime: [{ date: "2026-07-21", teamScore: 78, top20: 91 }, { date: "2026-07-28", teamScore: 80, top20: 92 }, { date: "2026-08-04", teamScore: 84, top20: 94 }, { date: "2026-08-11", teamScore: 86, top20: 95 }],
        scoreDistribution: [{ band: "0-59", count: 0, percent: 0 }, { band: "60-69", count: 3, percent: 4 }, { band: "70-79", count: 14, percent: 21 }, { band: "80-89", count: 31, percent: 46 }, { band: "90-100", count: 20, percent: 29 }],
        conversationOutcomes: [{ outcome: "Successful", count: 34 }, { outcome: "Converted", count: 24 }, { outcome: "In Progress", count: 7 }, { outcome: "No Outcome", count: 3 }],
        popularScenarios: [{ scenarioId: 1, title: "Homeowner Renovation Discovery", vertical: "home_improvement", averageScore: 88, sessionCount: 22 }, { scenarioId: 2, title: "Commercial Service Renewal", vertical: "home_improvement", averageScore: 85, sessionCount: 18 }, { scenarioId: 3, title: "Kitchen Upgrade Consultation", vertical: "home_improvement", averageScore: 83, sessionCount: 14 }, { scenarioId: 4, title: "Exterior Project Discovery", vertical: "home_improvement", averageScore: 79, sessionCount: 9 }, { scenarioId: 5, title: "Whole-home Assessment", vertical: "home_improvement", averageScore: 76, sessionCount: 5 }],
        achievements: [{ id: "gold-101", userId: 101, displayName: "Maya Chen", badge: "gold_achiever" as const, label: "Gold Achiever", earnedAt: ISO.recent }, { id: "top-101", userId: 101, displayName: "Maya Chen", badge: "top_performer" as const, label: "Top Performer", earnedAt: ISO.recent }, { id: "streak-102", userId: 102, displayName: "Jordan Reyes", badge: "streak_master" as const, label: "Streak Master", earnedAt: "2026-08-13T15:10:00.000Z" }, { id: "silver-103", userId: 103, displayName: "Priya Patel", badge: "silver_achiever" as const, label: "Discovery Certified", earnedAt: ISO.earlier }],
        summaryStrip: { teamMembersActive: 6, totalSessions: 154, avgScore: 84, goalProgress: 86, certificationsTotal: 3, hoursTrainedThisPeriod: 31 },
        widgetConfig,
      },
      readOnlyData: {
        teamHealthInsights: buildTeamHealthInsightsDrilldown(
          demoInsightUsers as any,
          demoInsightSessions as any,
          demoInsightScenarios as any,
          demoInsightPeriod,
        ),
        conversations: sessionInfo.map((session) => ({ consultantName: consultants.find((c) => c.id === session.consultantId)!.displayName, scenarioTitle: session.title, score: session.score, completedAt: session.completedAt, sessionId: session.id })),
        certifications: consultants.filter((consultant) => consultant.consultingCertified).map((consultant) => ({ consultantName: consultant.displayName, track: "consulting" as const, certifiedAt: consultant.consultingCertifiedAt! })),
        sessions: sessionDetails,
        scoreDistribution,
        performers,
      },
    },
  };
}
