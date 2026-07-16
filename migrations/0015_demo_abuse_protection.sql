-- Free-demo abuse protection signals on demo_sessions. These back the new
-- multi-layer fair-use caps that sit behind (and never change) the marketed
-- "3 free sessions per email" promise:
--   device_fingerprint  client-side FingerprintJS hash; enforces 3 sessions per
--                       device regardless of how many emails are used from it.
--                       Nullable because privacy tools can block fingerprinting.
--   ip_address          extracted server-side (trust proxy corrected) to enforce
--                       a durable 6-sessions-per-IP rolling-30-day cap that must
--                       survive restarts/deploys (hence a real column, not the
--                       in-memory RateLimiter).
--   session_number      this session's 1-based ordinal for the email, used to
--                       unlock server-side TTS (voice) only on the third free
--                       session for cost containment.
-- Idempotent (ADD COLUMN IF NOT EXISTS). Existing rows default session_number to
-- 1 and leave the fingerprint/IP null (unknown for historical demo traffic).
ALTER TABLE "demo_sessions" ADD COLUMN IF NOT EXISTS "device_fingerprint" text;--> statement-breakpoint
ALTER TABLE "demo_sessions" ADD COLUMN IF NOT EXISTS "ip_address" text;--> statement-breakpoint
ALTER TABLE "demo_sessions" ADD COLUMN IF NOT EXISTS "session_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_sessions_device_fingerprint_idx" ON "demo_sessions" ("device_fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_sessions_ip_address_idx" ON "demo_sessions" ("ip_address");
