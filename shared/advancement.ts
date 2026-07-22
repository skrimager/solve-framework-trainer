// Single source of truth for the level-advancement thresholds, shared by the
// server (authoritative enforcement in server/llm.ts) and the client (academy
// path in client/src/lib/progression.ts and the practice banner in
// client/src/pages/scenarios.tsx). Kept here so the number the UI shows can
// never drift from the number the server enforces.
//
// A session "qualifies" at a level only if it INDIVIDUALLY scores at or above
// ADVANCE_THRESHOLD — this is not an average, so one great session cannot carry
// a weak one. A level (and, at Advanced, exam eligibility) unlocks after
// REQUIRED_QUALIFYING_SESSIONS such sessions at that level. Identical at every
// level and on both tracks.
export const ADVANCE_THRESHOLD = 85;
export const REQUIRED_QUALIFYING_SESSIONS = 5;
