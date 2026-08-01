# Vapi Voice Pilot — Interruption Test Script

Read-aloud script for evaluating whether the Vapi pilot fixes the mid-sentence
cutoff problem. **Scenario: "Growing Family Needs More Room" (Priya) —
`auto-sales-growing-family-suv`. This is the only scenario the pilot serves.**

## Pass bar

> **Zero mid-sentence cutoffs across all test lines.**

A test line **fails** if Priya starts speaking at any point before you have
finished the entire line as written — including during the `[pause]` marks, which
are deliberate and are exactly the moments the old browser pipeline gets wrong.
One cutoff on one line means the run does not pass. Do not average, do not grade
on a curve: the whole point of the pilot is that a rep can pause to think without
being talked over.

Two things do **not** count as failures:

- Priya replying promptly *after* you finish a line. Fast is good.
- Priya stopping when you deliberately talk over her. Reps must always be able to
  interrupt; that direction is intended.

## Setup

1. Run the setup script if the assistants do not exist yet:
   `npm run vapi:setup` (needs `VAPI_API_KEY` + `VAPI_CUSTOM_LLM_URL`).
   Assistant IDs land in `VAPI_PILOT_ASSISTANTS.md`.
2. Set `VITE_VAPI_PUBLIC_KEY` and `VITE_VAPI_ASSISTANT_ID`, plus either
   `VITE_VAPI_PILOT_ENABLED=1` or append `?vapi=1` to the roleplay URL.
3. Start a session on **Growing Family Needs More Room** and switch **Voice mode**
   on. Priya waits for you to speak first.
4. Use a headset. Speaker-to-mic bleed produces cutoffs that are an acoustics
   problem, not an endpointing problem, and will muddy the result.
5. Read each line at a normal, unhurried sales pace. Hold every `[pause N]` for
   at least N seconds of real silence — resist the urge to fill it.

## Run both voices

Complete the full table once per assistant so the comparison is like-for-like.
Swap `VITE_VAPI_ASSISTANT_ID` between the two IDs in
`VAPI_PILOT_ASSISTANTS.md` and re-run. Record which voice you prefer by ear at the
bottom; that is a separate judgment from the pass bar, which is about cutoffs only.

- Voice under test: `_______________________` (assistant name / ID)
- Date / tester: `_______________________`

## Test lines

| # | Stressor | Read this aloud, exactly as written | No cutoff? | Notes (where it cut in, what you heard) |
|---|----------|--------------------------------------|:----------:|-----------------------------------------|
| 1 | Mid-sentence pause on a number | "So the monthly payment would be... [pause 3] let me pull up the exact number... [pause 3] around four hundred and twenty dollars a month." | ☐ | |
| 2 | Filler-word stall | "Um... [pause 2] so... [pause 2] like, you know, the thing most families in your situation care about... [pause 2] is the third row." | ☐ | |
| 3 | Slow list | "You'd be getting, one... [pause 2] the third-row seating, two... [pause 2] the top safety rating, and three... [pause 2] the extended warranty." | ☐ | |
| 4 | Digits read slowly | "The stock number is four... [pause 2] seven... [pause 2] two... [pause 2] nine... [pause 2] and that one's on the lot today." | ☐ | |
| 5 | Trailing conjunction | "I hear you on the cargo space, and... [pause 3] honestly, that's the part most people underestimate until the stroller goes in." | ☐ | |
| 6 | Long uninterrupted multi-clause sentence (no pauses) | "What I'd suggest, given that you're seven months along and Sam is doing most of the driving right now, is that we look at the two trims that have the power lift-gate as standard rather than as an add-on, because that's the feature you'll actually be using every single day once the car seat is in, and then we compare the total monthly cost side by side so you can see exactly what the difference buys you." | ☐ | |
| 7 | Thinking-out-loud restart | "The safety rating on that one is... [pause 3] actually, hold on... [pause 3] I want to give you the current model year, not last year's." | ☐ | |
| 8 | Question with a pause before the question mark | "Before I pull numbers — what matters more to you... [pause 3] the monthly payment, or the cargo space?" | ☐ | |
| 9 | Correcting yourself mid-figure | "It's about thirty-nine, no... [pause 2] thirty-eight five... [pause 2] before we talk about the trade-in." | ☐ | |
| 10 | Long pause with no trailing cue | "Let me think about the best way to lay this out for you. [pause 5] Okay — here's what I'd do." | ☐ | |

## Interruption check (the opposite direction)

This should still work. It is not part of the pass bar but a regression here makes
the pilot unusable.

| # | Do this | Priya yields? | Notes |
|---|---------|:-------------:|-------|
| I1 | While Priya is mid-reply, start talking normally ("Actually, can I stop you there —"). She should stop within about a second. | ☐ | |
| I2 | While Priya is mid-reply, say a single filler word ("um") and go quiet. She should **keep going** — a stray "um" is not an interruption. | ☐ | |

## Result

- Lines 1-10 with **zero** cutoffs: ☐ **PASS** / ☐ **FAIL**
- Cutoffs observed on line(s): `____________________`
- Preferred voice by ear, and why: `____________________`
- Anything else worth flagging (latency, audio quality, transcript accuracy):

```
```

## If a line fails

The knobs are all in `scripts/setup-vapi-pilot.ts`, which is re-runnable and
patches the existing assistants in place, so tune and re-run rather than creating
new ones:

- Cut off **during** a `[pause]` → the endpointer decided the turn was over.
  Raise `START_SPEAKING_PLAN.waitSeconds`, make the `smartEndpointingPlan`
  `waitFunction` more patient, or raise
  `transcriptionEndpointingPlan.onNoPunctuationSeconds`.
- Cut off **on a number** (lines 1, 4, 9) → raise
  `transcriptionEndpointingPlan.onNumberSeconds`, and check the
  `customEndpointingRules` regex still matches trailing digits.
- Cut off after a **filler word or conjunction** (lines 2, 5) → the word is being
  treated as a complete turn. Add it to `STOP_SPEAKING_PLAN.acknowledgementPhrases`
  and confirm it is not in `interruptionPhrases`.
- Priya **fails to yield** on I1 → lower `STOP_SPEAKING_PLAN.numWords` (currently
  3) one step at a time. Note the trade-off: lower means faster yielding *and*
  more mid-sentence cutoffs, which is why it starts high.
