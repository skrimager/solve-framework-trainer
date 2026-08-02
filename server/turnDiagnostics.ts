// Per-turn diagnostic logging for the customer reply.
//
// Everything that decides what the customer says on a given turn is derived
// fresh from the transcript and then thrown away: which rules matched, what
// they detected, and what text that produced all live for the duration of one
// request. When a reply comes out wrong there is nothing left to inspect, so
// diagnosis reduces to re-reading the transcript and guessing which rule should
// have fired. That guesswork is what this module removes.
//
// It is strictly additive: it reads the same derivations the prompt builder
// reads and prints them. It never feeds anything back into the prompt, changes
// control flow, or runs when the flag is off.
import {
  deriveAlignmentGate,
  deriveConversationState,
  deriveDirectQuestion,
  deriveDisclosureGate,
} from "./conversationState";
import { buildTurnStateBlock, informationLayersEnabled } from "./llm";
import type { GatedTopic } from "./persona";
import type { TranscriptMessage } from "@shared/schema";

export const TURN_DIAGNOSTICS_FLAG = "TURN_DIAGNOSTICS";
const TAG = "[TURN_DIAGNOSTICS]";

// Off unless explicitly switched on, because the state block quotes every line
// the customer has already said and grows with the conversation. Same truthy
// spellings the information-layers flag accepts, so operators only learn one
// convention.
export function turnDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[TURN_DIAGNOSTICS_FLAG] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export interface TurnDiagnosticsContext {
  msgId: string;
  scenarioId?: number | string;
  difficulty: string;
  escalationTier: number;
  history: TranscriptMessage[];
  // This scenario's gated Layer 2/3 subjects, if it declares any. Passed in
  // rather than looked up from the scenario id so the log shows the exact list
  // the prompt builder was handed on this turn.
  gatedTopics?: GatedTopic[];
}

// Long free text is quoted and fenced rather than truncated. A state block cut
// off at N characters loses exactly the tail that says what the customer must
// not do, which is usually the part under investigation.
function fence(label: string, body: string): string {
  return `${label}:\n<<<\n${body}\n>>>`;
}

function summarizeDirectQuestion(history: TranscriptMessage[]): string {
  const q = deriveDirectQuestion(history);
  if (!q) return "directQuestion: (none)";
  return [
    `directQuestion: FIRED asks=${q.asks.length} narrowing=${q.narrowing}`,
    `    vagueAnswer=${JSON.stringify(q.vagueAnswer)}`,
    `    redirectedTopic=${JSON.stringify(q.redirectedTopic)} sequencedTopic=${JSON.stringify(q.sequencedTopic)}`,
    ...q.asks.map((a, i) => `    ask[${i}]=${JSON.stringify(a)}`),
  ].join("\n  ");
}

function summarizeAlignmentGate(history: TranscriptMessage[], active: boolean): string {
  const g = deriveAlignmentGate(history);
  const state =
    `useCase=${g.useCase} whoElse=${g.whoElse} motivation=${g.motivation} ` +
    `concern=${g.concern} satisfied=${g.satisfied} featureDive=${JSON.stringify(g.featureDive)}`;
  // Derived either way, so the log shows what the gate WOULD have said on a turn
  // where the flag was off. That distinction is the whole question when a rule
  // appears not to have worked.
  return `alignmentGate: ${active ? "ACTIVE" : "derived-but-INACTIVE(flag off)"} ${state}`;
}

function summarizeDisclosureGate(history: TranscriptMessage[], topics: GatedTopic[]): string {
  if (topics.length === 0) return "disclosureGate: (persona declares no gated topics)";
  const g = deriveDisclosureGate(history, topics);
  return [
    `disclosureGate: withheld=${g.withheld.length}/${g.topics.length}`,
    ...g.topics.map(
      (t) =>
        `    ${t.earned ? "EARNED " : "WITHHELD"} ${JSON.stringify(t.label)}` +
        (t.openedBy ? ` openedBy=${JSON.stringify(t.openedBy)}` : ""),
    ),
  ].join("\n  ");
}

function summarizeConversationState(history: TranscriptMessage[]): string {
  const s = deriveConversationState(history);
  const deflected = s.deflectedTopics
    .map((t) => `${t.topic}(n=${t.redirectCount},closed=${t.closed})`)
    .join(", ");
  const sequenced = s.sequencedTopics
    .map((t) => `${JSON.stringify(t.label)}(n=${t.redirectCount},closed=${t.closed})`)
    .join(", ");
  return [
    `conversationState:`,
    `    deflectedTopics=[${deflected}]`,
    `    sequencedTopics=[${sequenced}]`,
    `    decisionMaker=${s.decisionMaker ? JSON.stringify(s.decisionMaker.answer) : "null"}`,
    `    alternativesRequests=${s.alternativesRequests} alternativesRoundSpent=${s.alternativesRoundSpent}`,
    `    acceptedSolutionLine=${JSON.stringify(s.acceptedSolutionLine)}`,
    `    quotedFacts=[${s.quotedFacts.join(", ")}]`,
    `    metNeed=${s.metNeed ? `stated=${s.metNeed.statedAmount} quoted=${s.metNeed.quotedAmount} gapClosed=${s.metNeed.gapClosed}` : "null"}`,
  ].join("\n  ");
}

// Logs the inputs and derived state for one turn, immediately before the model
// is called. Any throw here is swallowed: a diagnostic must never be able to
// take down a live customer reply.
export function logTurnInputs(ctx: TurnDiagnosticsContext): void {
  if (!turnDiagnosticsEnabled()) return;
  try {
    const layers = informationLayersEnabled();
    const consultantTurns = ctx.history.filter((m) => m.role === "consultant").length;
    const last = [...ctx.history].reverse().find((m) => m.role === "consultant");

    const gatedTopics = ctx.gatedTopics ?? [];

    const parts = [
      `${TAG} msgId=${ctx.msgId} scenario=${ctx.scenarioId ?? "?"} difficulty=${ctx.difficulty}`,
      `  flags: informationLayers=${layers} alignmentGateActive=${layers} escalationTier=${ctx.escalationTier}`,
      `  turn: consultantTurns=${consultantTurns} historyLength=${ctx.history.length}`,
      `  ${fence("  lastConsultantMessage", last ? last.content.trim() : "(none)")}`,
      `  ${summarizeDirectQuestion(ctx.history)}`,
      `  ${summarizeAlignmentGate(ctx.history, layers)}`,
      `  ${summarizeDisclosureGate(ctx.history, gatedTopics)}`,
      `  ${summarizeConversationState(ctx.history)}`,
      // The exact text appended to the prompt. This is the ground truth for
      // "which rules produced output this turn": every state-block builder,
      // including any added later, shows up here without this file changing.
      `  ${fence("  stateBlockAppendedToPrompt", buildTurnStateBlock(ctx.history, layers, gatedTopics) || "(empty)")}`,
    ];
    console.log(parts.join("\n"));
  } catch (err) {
    console.warn(`${TAG} failed to log turn inputs:`, err);
  }
}

// Logs the model's raw reply once the stream has finished.
export function logTurnResponse(msgId: string, rawResponse: string): void {
  if (!turnDiagnosticsEnabled()) return;
  try {
    console.log(`${TAG} msgId=${msgId} ${fence("rawModelResponse", rawResponse)}`);
  } catch (err) {
    console.warn(`${TAG} failed to log turn response:`, err);
  }
}
