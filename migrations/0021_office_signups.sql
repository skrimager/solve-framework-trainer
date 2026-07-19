CREATE TABLE IF NOT EXISTS "office_signups" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"company" text NOT NULL,
	"code" text,
	"code_expires_at" text,
	"verified" boolean NOT NULL DEFAULT false,
	"manager_name" text,
	"username" text,
	"password" text,
	"seat_count" integer,
	"dashboard" boolean NOT NULL DEFAULT false,
	"created_at" text NOT NULL,
	"last_sent_at" text,
	CONSTRAINT "office_signups_email_unique" UNIQUE("email")
);
