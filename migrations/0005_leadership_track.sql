ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "track" text NOT NULL DEFAULT 'consulting';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "leadership_level" text NOT NULL DEFAULT 'beginner';
