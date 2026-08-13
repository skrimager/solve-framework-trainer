import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { TranscriptMessage } from "@shared/schema";
import { logTurnInputs, logTurnResponse, turnDiagnosticsEnabled } from "./turnDiagnostics";

// Terse transcript builder: "c: ..." is the customer, "r: ..." is the rep.
function t(...lines: string[]): TranscriptMessage[] {
  return lines.map((line) => {
    const role = line.startsWith("c:") ? "customer" : "consultant";
    return {
      role,
      content: line.slice(2).trim(),
      timestamp: new Date().toISOString(),
    } as TranscriptMessage;
  });
}

// Captures console.log/warn for the duration of one call.
function capture(fn: () => void): string {
  const lines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return lines.join("\n");
}

function withFlag(value: string | undefined, fn: () => void): void {
  const prev = process.env.TURN_DIAGNOSTICS;
  if (value === undefined) delete process.env.TURN_DIAGNOSTICS;
  else process.env.TURN_DIAGNOSTICS = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.TURN_DIAGNOSTICS;
    else process.env.TURN_DIAGNOSTICS = prev;
  }
}

const CTX = {
  msgId: "m1",
  scenarioId: 7,
  difficulty: "intermediate",
  escalationTier: 2,
  history: t(
    "c: We need something safe for the baby.",
    "r: That Explorer has 180,000 miles on it and it's over priced.",
  ),
};

describe("turn diagnostics flag", () => {
  test("defaults off so production is never spammed", () => {
    assert.equal(turnDiagnosticsEnabled({}), false);
    assert.equal(turnDiagnosticsEnabled({ TURN_DIAGNOSTICS: "" }), false);
    assert.equal(turnDiagnosticsEnabled({ TURN_DIAGNOSTICS: "0" }), false);
    assert.equal(turnDiagnosticsEnabled({ TURN_DIAGNOSTICS: "false" }), false);
  });

  test("accepts supported truthy spellings", () => {
    for (const raw of ["1", "true", "on", "yes", "TRUE", " Yes "]) {
      assert.equal(turnDiagnosticsEnabled({ TURN_DIAGNOSTICS: raw }), true, raw);
    }
  });

  test("emits nothing at all when the flag is off", () => {
    withFlag(undefined, () => {
      assert.equal(capture(() => logTurnInputs(CTX)), "");
      assert.equal(capture(() => logTurnResponse("m1", "hello")), "");
    });
  });
});

describe("turn diagnostics output", () => {
  test("records the turn context, escalation tier and scenario", () => {
    withFlag("true", () => {
      const out = capture(() => logTurnInputs(CTX));
      assert.match(out, /\[TURN_DIAGNOSTICS\]/);
      assert.match(out, /msgId=m1/);
      assert.match(out, /scenario=7/);
      assert.match(out, /difficulty=intermediate/);
      assert.match(out, /escalationTier=2/);
    });
  });

  test("includes the exact state block that gets appended to the prompt", () => {
    withFlag("true", () => {
      const out = capture(() => logTurnInputs(CTX));
      assert.match(out, /stateBlockAppendedToPrompt/);
      // The rep's actual words must survive into the log verbatim, since that is
      // what makes "which rule saw what" answerable after the fact.
      assert.match(out, /180,000 miles/);
    });
  });

  test("logs the model's raw reply", () => {
    withFlag("true", () => {
      const out = capture(() => logTurnResponse("m9", "That's not what I expected at all."));
      assert.match(out, /msgId=m9/);
      assert.match(out, /rawModelResponse/);
      assert.match(out, /That's not what I expected at all\./);
    });
  });
});

describe("turn diagnostics safety", () => {
  // A diagnostic that can throw is a diagnostic that can take down a live reply.
  test("survives an empty transcript", () => {
    withFlag("true", () => {
      assert.doesNotThrow(() =>
        capture(() => logTurnInputs({ ...CTX, history: [] })),
      );
    });
  });

  test("survives a transcript with no consultant turn", () => {
    withFlag("true", () => {
      const out = capture(() =>
        logTurnInputs({ ...CTX, history: t("c: Just looking, thanks.") }),
      );
      assert.match(out, /lastConsultantMessage/);
    });
  });

  test("never throws on a malformed transcript", () => {
    withFlag("true", () => {
      const bad = [{ role: "consultant" } as unknown as TranscriptMessage];
      assert.doesNotThrow(() => capture(() => logTurnInputs({ ...CTX, history: bad })));
    });
  });
});
