-- Deterministic result cache for Real Conversation Scoring (server/llm.ts
-- scoreTranscript). OpenAI's Responses API exposes no seed parameter and does
-- not guarantee identical output even at temperature 0, so scoring the same
-- transcript twice can return different scores and feedback. This table makes
-- scoring deterministic by construction: a sha256 hash over everything that
-- affects the result (transcript role+content in order, difficulty, track,
-- transaction_type) keys a stored { rubric, feedback, overall }. A cache hit
-- returns the stored result with NO API call; a miss calls the API and stores
-- the result before returning it.
--
-- content_hash is UNIQUE (its constraint is backed by an index, satisfying the
-- lookup path). rubric is JSON text, matching the sessions.rubric_scores
-- convention. transcript/transaction_type are stored for debuggability only;
-- lookups key solely on content_hash.
--
-- Idempotent (IF NOT EXISTS) so re-running is safe.
CREATE TABLE IF NOT EXISTS "score_cache" (
  "id" serial PRIMARY KEY NOT NULL,
  "content_hash" text NOT NULL,
  "rubric" text NOT NULL,
  "feedback" text NOT NULL,
  "overall" integer NOT NULL,
  "track" text NOT NULL,
  "difficulty" text NOT NULL,
  "transaction_type" text,
  "transcript" text NOT NULL,
  "created_at" text NOT NULL,
  CONSTRAINT "score_cache_content_hash_unique" UNIQUE("content_hash")
);
