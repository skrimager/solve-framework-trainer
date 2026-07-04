CREATE TABLE IF NOT EXISTS "offices" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"invite_code" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "offices_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "office_id" integer;--> statement-breakpoint
INSERT INTO "offices" ("name", "invite_code", "created_at")
VALUES ('Demo Office', 'DEMO2024', now()::text)
ON CONFLICT ("invite_code") DO NOTHING;--> statement-breakpoint
UPDATE "users"
SET "office_id" = (SELECT "id" FROM "offices" WHERE "invite_code" = 'DEMO2024')
WHERE "office_id" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "office_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "users" ADD CONSTRAINT "users_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
