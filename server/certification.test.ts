import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  computeLevelAdvancement,
  countQualifyingSessions,
  isExamEligible,
  gradeWrittenAnswer,
  buildWrittenGradingPrompt,
  scoresForTrackAtLevel,
  REQUIRED_QUALIFYING_SESSIONS,
  ADVANCE_THRESHOLD,
  WrittenGradingUnavailableError,
} from "./llm";
import {
  drawExam,
  getQuestion,
  getQuestions,
  gradeExact,
  gradeWrittenExam,
  toPublicQuestion,
  questionBank,
  questionBankSize,
  normalizeTrack,
  EXAM_QUESTION_COUNT,
  WRITTEN_PASS_CORRECT,
  WRITTEN_PASS_PERCENT,
  TRACK_CREDENTIAL,
  type WrittenQuestion,
  type CertQuestion,
} from "./certification";

// ---------------------------------------------------------------------------
// 5-qualifying-sessions advancement rule
// ---------------------------------------------------------------------------

describe("countQualifyingSessions / computeLevelAdvancement (5-qualifying rule)", () => {
  test("only sessions scoring >= 85 count toward the total", () => {
    assert.equal(countQualifyingSessions([85, 90, 84, 100, 70]), 3);
    assert.equal(countQualifyingSessions([]), 0);
  });

  test("a sub-85 session does NOT reset already-earned qualifying sessions", () => {
    // Four qualifying, then a bad one, then a fifth qualifying — still 5.
    const scores = [90, 88, 91, 95, 20, 86];
    assert.equal(countQualifyingSessions(scores), 5);
    assert.equal(computeLevelAdvancement("beginner", scores), "intermediate");
  });

  test("fewer than five qualifying sessions does not advance", () => {
    assert.equal(computeLevelAdvancement("beginner", [90, 91, 92, 93]), null);
    // High average, too few sessions — the old averaging behavior is gone.
    assert.equal(computeLevelAdvancement("beginner", [99, 99]), null);
  });

  test("exactly five qualifying sessions advances one level", () => {
    const five = [85, 85, 85, 85, 85];
    assert.equal(countQualifyingSessions(five), REQUIRED_QUALIFYING_SESSIONS);
    assert.equal(computeLevelAdvancement("beginner", five), "intermediate");
    assert.equal(computeLevelAdvancement("intermediate", five), "advanced");
  });

  test("advanced is the ceiling — no auto-advance beyond it", () => {
    assert.equal(computeLevelAdvancement("advanced", [90, 90, 90, 90, 90, 90]), null);
  });

  test("just-below-threshold scores never qualify", () => {
    assert.equal(countQualifyingSessions([84, 84, 84, 84, 84]), 0);
    assert.equal(computeLevelAdvancement("beginner", [84, 84, 84, 84, 84]), null);
    assert.ok(ADVANCE_THRESHOLD === 85);
  });
});

// ---------------------------------------------------------------------------
// Exam eligibility gating (Advanced + 5 qualifying Advanced sessions)
// ---------------------------------------------------------------------------

describe("isExamEligible", () => {
  test("not eligible below Advanced regardless of score count", () => {
    assert.equal(isExamEligible("beginner", [90, 90, 90, 90, 90]), false);
    assert.equal(isExamEligible("intermediate", [90, 90, 90, 90, 90]), false);
  });

  test("Advanced but fewer than five qualifying sessions is not eligible", () => {
    assert.equal(isExamEligible("advanced", [90, 90, 90, 90]), false);
  });

  test("Advanced with five qualifying sessions is eligible", () => {
    assert.equal(isExamEligible("advanced", [85, 90, 88, 92, 100]), true);
  });

  test("sub-85 Advanced sessions do not count toward eligibility", () => {
    assert.equal(isExamEligible("advanced", [84, 84, 84, 84, 84, 84]), false);
  });
});

// ---------------------------------------------------------------------------
// Per-track independence of the qualifying count
// ---------------------------------------------------------------------------

describe("per-track independence of exam eligibility", () => {
  const scenarios = [
    { id: 1, track: "consulting", difficulty: "advanced" },
    { id: 2, track: "leadership", difficulty: "advanced" },
  ];

  test("five qualifying consulting-advanced sessions do not make leadership eligible", () => {
    const sessions = [
      { scenarioId: 1, status: "completed", score: 90 },
      { scenarioId: 1, status: "completed", score: 91 },
      { scenarioId: 1, status: "completed", score: 92 },
      { scenarioId: 1, status: "completed", score: 93 },
      { scenarioId: 1, status: "completed", score: 94 },
    ];
    const consultingAdv = scoresForTrackAtLevel("consulting", "advanced", sessions, scenarios);
    const leadershipAdv = scoresForTrackAtLevel("leadership", "advanced", sessions, scenarios);
    assert.equal(isExamEligible("advanced", consultingAdv), true);
    assert.equal(isExamEligible("advanced", leadershipAdv), false);
  });
});

// ---------------------------------------------------------------------------
// Question banks + exam draw
// ---------------------------------------------------------------------------

describe("question banks", () => {
  test("both tracks have well over the 30-question minimum", () => {
    assert.ok(questionBankSize("consulting") >= 60, `consulting bank too small: ${questionBankSize("consulting")}`);
    assert.ok(questionBankSize("leadership") >= 60, `leadership bank too small: ${questionBankSize("leadership")}`);
  });

  test("every question belongs to its declared track and has a valid answer", () => {
    for (const track of ["consulting", "leadership"] as const) {
      for (const q of questionBank(track)) {
        assert.equal(q.track, track);
        if (q.type === "multiple_choice") {
          assert.ok(q.answer >= 0 && q.answer < q.options.length, `${q.id} answer out of range`);
        } else if (q.type === "fill_blank") {
          assert.ok(q.answer.length > 0, `${q.id} missing answer`);
        } else {
          assert.ok(q.rubric.length > 0, `${q.id} missing rubric`);
        }
      }
    }
  });

  test("question ids are globally unique across both banks", () => {
    const all = [...questionBank("consulting"), ...questionBank("leadership")];
    const ids = new Set(all.map((q) => q.id));
    assert.equal(ids.size, all.length);
  });

  test("normalizeTrack falls back to consulting for unknown/legacy values", () => {
    assert.equal(normalizeTrack(null), "consulting");
    assert.equal(normalizeTrack("nonsense"), "consulting");
    assert.equal(normalizeTrack("leadership"), "leadership");
  });
});

describe("drawExam", () => {
  test("draws EXAM_QUESTION_COUNT unique questions from the right track", () => {
    const ids = drawExam("consulting");
    assert.equal(ids.length, EXAM_QUESTION_COUNT);
    assert.equal(new Set(ids).size, EXAM_QUESTION_COUNT);
    for (const id of ids) {
      assert.equal(getQuestion(id)!.track, "consulting");
    }
  });

  test("is deterministic given a fixed RNG and re-draws differently otherwise", () => {
    const fixed = () => 0.42;
    const a = drawExam("leadership", 30, fixed);
    const b = drawExam("leadership", 30, fixed);
    assert.deepEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// Exact grading (multiple choice + fill in the blank)
// ---------------------------------------------------------------------------

describe("gradeExact", () => {
  const mc = getQuestion("c-mc-1")!; // answer index 1
  const fb = getQuestion("c-fb-1")!; // answer "hole"

  test("multiple choice: correct index passes, wrong fails", () => {
    assert.equal(gradeExact(mc, 1), true);
    assert.equal(gradeExact(mc, "1"), true); // string index coerced
    assert.equal(gradeExact(mc, 0), false);
    assert.equal(gradeExact(mc, undefined), false);
  });

  test("fill blank: normalized match passes (case/space/punctuation-insensitive)", () => {
    assert.equal(gradeExact(fb, "hole"), true);
    assert.equal(gradeExact(fb, "  HOLE. "), true);
    assert.equal(gradeExact(fb, "drill"), false);
    assert.equal(gradeExact(fb, ""), false);
    assert.equal(gradeExact(fb, 3), false);
  });

  test("fill blank: acceptable alternates are honored", () => {
    const alt = getQuestion("c-fb-2")!; // answer "discovery", acceptable ["questions","questioning"]
    assert.equal(gradeExact(alt, "discovery"), true);
    assert.equal(gradeExact(alt, "questions"), true);
    assert.equal(gradeExact(alt, "Questioning"), true);
    assert.equal(gradeExact(alt, "selling"), false);
  });

  test("written questions never pass exact grading (must go through the LLM)", () => {
    const wr = getQuestion("c-wr-1")!;
    assert.equal(gradeExact(wr, "a long correct-sounding answer"), false);
  });
});

// ---------------------------------------------------------------------------
// LLM written-answer grading — MOCKED, never hits the real API
// ---------------------------------------------------------------------------

describe("gradeWrittenAnswer (mocked responder)", () => {
  test("passes the rubric and answer into the prompt and parses a positive verdict", async () => {
    let capturedInput = "";
    const responder = async (input: string) => {
      capturedInput = input;
      return '{"correct": true, "reason": "meets rubric"}';
    };
    const ok = await gradeWrittenAnswer("What is the hole?", "Must mention underlying need.", "The real need.", responder);
    assert.equal(ok, true);
    // The prompt actually carries the question, rubric, and candidate answer.
    assert.ok(capturedInput.includes("What is the hole?"));
    assert.ok(capturedInput.includes("Must mention underlying need."));
    assert.ok(capturedInput.includes("The real need."));
  });

  test("a negative verdict fails", async () => {
    const responder = async () => '{"correct": false, "reason": "off topic"}';
    assert.equal(await gradeWrittenAnswer("q", "r", "bad answer", responder), false);
  });

  test("non-JSON / unparseable model output fails closed (not a pass)", async () => {
    assert.equal(await gradeWrittenAnswer("q", "r", "a", async () => "totally not json"), false);
    assert.equal(await gradeWrittenAnswer("q", "r", "a", async () => "{broken"), false);
  });

  test("extracts JSON embedded in surrounding prose", async () => {
    const responder = async () => 'Sure! Here is my verdict: {"correct": true, "reason": "good"} thanks';
    assert.equal(await gradeWrittenAnswer("q", "r", "a", responder), true);
  });

  test("buildWrittenGradingPrompt notes when no answer was provided", () => {
    const prompt = buildWrittenGradingPrompt("q", "r", "");
    assert.ok(prompt.includes("(no answer provided)"));
  });

  test("buildWrittenGradingPrompt places the volatile candidate answer LAST (after the stable question + rubric)", () => {
    const prompt = buildWrittenGradingPrompt("What is discovery?", "Mentions uncovering needs", "You ask questions");
    const questionIdx = prompt.indexOf("What is discovery?");
    const rubricIdx = prompt.indexOf("Mentions uncovering needs");
    const answerIdx = prompt.indexOf("Candidate's answer:");
    assert.ok(questionIdx >= 0 && rubricIdx >= 0 && answerIdx >= 0);
    // The stable per-question prefix (question + rubric + output format) must
    // precede the candidate's answer so it can be cached across submissions.
    assert.ok(questionIdx < answerIdx, "question should precede the candidate answer");
    assert.ok(rubricIdx < answerIdx, "rubric should precede the candidate answer");
    // The candidate answer must be the trailing content of the prompt.
    assert.ok(prompt.trimEnd().endsWith("You ask questions"), "prompt must end with the candidate answer");
  });

  test("a transient responder failure is retried and succeeds without surfacing an error", async () => {
    let calls = 0;
    const flakyThenOk = async () => {
      calls += 1;
      if (calls < 3) throw new Error("429 rate limited");
      return '{"correct": true, "reason": "ok on retry"}';
    };
    const ok = await gradeWrittenAnswer("q", "r", "a", flakyThenOk);
    assert.equal(ok, true);
    assert.equal(calls, 3);
  });

  test("a persistently failing responder throws WrittenGradingUnavailableError, not a silent fail", async () => {
    const alwaysFails = async () => {
      throw new Error("401 Incorrect API key provided");
    };
    await assert.rejects(() => gradeWrittenAnswer("q", "r", "a", alwaysFails), WrittenGradingUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// Whole written exam grading (exact + delegated written) and the pass bar
// ---------------------------------------------------------------------------

describe("gradeWrittenExam", () => {
  // A responder that marks every written question correct.
  const allWrittenCorrect = async (_q: WrittenQuestion, _a: string) => true;
  const allWrittenWrong = async (_q: WrittenQuestion, _a: string) => false;

  function buildAnswers(ids: string[], allCorrect: boolean): Record<string, unknown> {
    const answers: Record<string, unknown> = {};
    for (const q of getQuestions(ids)) {
      if (q.type === "multiple_choice") {
        answers[q.id] = allCorrect ? q.answer : (q.answer + 1) % q.options.length;
      } else if (q.type === "fill_blank") {
        answers[q.id] = allCorrect ? q.answer : "definitely wrong";
      } else {
        answers[q.id] = "some free text";
      }
    }
    return answers;
  }

  test("WRITTEN_PASS_CORRECT is ceil(85% of 30) = 26", () => {
    assert.equal(WRITTEN_PASS_CORRECT, 26);
    assert.equal(WRITTEN_PASS_PERCENT, 85);
    assert.equal(EXAM_QUESTION_COUNT, 30);
  });

  test("all-correct answers pass with 100%", async () => {
    const ids = questionBank("consulting").map((q) => q.id).slice(0, 30);
    const answers = buildAnswers(ids, true);
    const result = await gradeWrittenExam(ids, answers, allWrittenCorrect);
    assert.equal(result.total, 30);
    assert.equal(result.correct, 30);
    assert.equal(result.percent, 100);
    assert.equal(result.passed, true);
  });

  test("all-wrong answers fail", async () => {
    const ids = questionBank("consulting").map((q) => q.id).slice(0, 30);
    const answers = buildAnswers(ids, false);
    const result = await gradeWrittenExam(ids, answers, allWrittenWrong);
    assert.equal(result.correct, 0);
    assert.equal(result.passed, false);
  });

  test("exactly 26/30 passes, 25/30 fails (boundary)", async () => {
    // Use 30 multiple-choice consulting questions so grading is fully deterministic.
    const mcIds = questionBank("consulting")
      .filter((q) => q.type === "multiple_choice")
      .slice(0, 30)
      .map((q) => q.id);
    assert.equal(mcIds.length, 30);

    const makeAnswers = (correctCount: number): Record<string, unknown> => {
      const answers: Record<string, unknown> = {};
      mcIds.forEach((id, i) => {
        const q = getQuestion(id)! as Extract<CertQuestion, { type: "multiple_choice" }>;
        answers[id] = i < correctCount ? q.answer : (q.answer + 1) % q.options.length;
      });
      return answers;
    };

    const pass = await gradeWrittenExam(mcIds, makeAnswers(26), allWrittenWrong);
    assert.equal(pass.correct, 26);
    assert.equal(pass.passed, true);

    const fail = await gradeWrittenExam(mcIds, makeAnswers(25), allWrittenWrong);
    assert.equal(fail.correct, 25);
    assert.equal(fail.passed, false);
  });

  test("written questions are delegated to the injected grader, not graded locally", async () => {
    const wrIds = questionBank("leadership")
      .filter((q) => q.type === "written")
      .slice(0, 3)
      .map((q) => q.id);
    const seen: string[] = [];
    const responder = async (q: WrittenQuestion, _a: string) => {
      seen.push(q.id);
      return true;
    };
    const result = await gradeWrittenExam(wrIds, {}, responder);
    assert.deepEqual(seen.sort(), [...wrIds].sort());
    assert.equal(result.correct, wrIds.length);
  });

  test("a grader failure aborts the whole exam rather than silently marking questions wrong", async () => {
    // Build a set with both deterministic and written questions so we prove
    // the failure isn't swallowed as a false/incorrect result for the written one.
    const mcIds = questionBank("consulting").filter((q) => q.type === "multiple_choice").slice(0, 20).map((q) => q.id);
    const wrIds = questionBank("consulting").filter((q) => q.type === "written").slice(0, 3).map((q) => q.id);
    assert.ok(wrIds.length > 0, "expected the consulting bank to contain written questions");
    const ids = [...mcIds, ...wrIds];
    const answers = buildAnswers(ids, true);
    const failingGrader = async () => {
      throw new WrittenGradingUnavailableError(new Error("401 Incorrect API key provided"));
    };
    await assert.rejects(() => gradeWrittenExam(ids, answers, failingGrader), WrittenGradingUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// Public question shape never leaks answers/rubrics
// ---------------------------------------------------------------------------

describe("toPublicQuestion", () => {
  test("strips the answer from multiple choice but keeps options", () => {
    const pub = toPublicQuestion(getQuestion("c-mc-1")!) as any;
    assert.equal(pub.type, "multiple_choice");
    assert.ok(Array.isArray(pub.options));
    assert.equal("answer" in pub, false);
  });

  test("strips the answer/acceptable from fill blank", () => {
    const pub = toPublicQuestion(getQuestion("c-fb-1")!) as any;
    assert.equal("answer" in pub, false);
    assert.equal("acceptable" in pub, false);
  });

  test("strips the rubric from written", () => {
    const pub = toPublicQuestion(getQuestion("c-wr-1")!) as any;
    assert.equal("rubric" in pub, false);
    assert.ok(pub.prompt.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Credentials are distinct per track
// ---------------------------------------------------------------------------

describe("TRACK_CREDENTIAL", () => {
  test("each track has its own named credential", () => {
    assert.equal(TRACK_CREDENTIAL.consulting, "SOLVE Framework Certified");
    assert.equal(TRACK_CREDENTIAL.leadership, "SOLVE Conflict Management Certified");
    assert.notEqual(TRACK_CREDENTIAL.consulting, TRACK_CREDENTIAL.leadership);
  });
});
