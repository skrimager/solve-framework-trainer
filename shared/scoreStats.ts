// Pure, dependency-free score helpers shared by the rep's history views. Kept out
// of any React file so the running-average logic is unit-testable without a DOM
// or a DB. Nothing here touches practice scoring or pricing; it only summarizes
// scores that were already computed elsewhere.

// All-time running average across a set of scores, rounded to the nearest whole
// number to match how individual scores are displayed. Entries that are null or
// undefined (a submission still awaiting its score) are excluded so a pending row
// never drags the average toward zero. Returns null when nothing has been scored
// yet, so callers can render a clear empty state instead of a misleading 0 or NaN.
export function averageScore(scores: ReadonlyArray<number | null | undefined>): number | null {
  const scored = scores.filter((s): s is number => typeof s === "number");
  if (scored.length === 0) return null;
  const sum = scored.reduce((total, score) => total + score, 0);
  return Math.round(sum / scored.length);
}
