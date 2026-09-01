CREATE TABLE "game_roles" (
	"guild_id" text NOT NULL,
	"game_slug" text NOT NULL,
	"role_id" text NOT NULL,
	CONSTRAINT "game_roles_guild_id_game_slug_pk" PRIMARY KEY("guild_id","game_slug")
);
--> statement-breakpoint
CREATE TABLE "guild_config" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"match_log_channel_id" text
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"game_slug" text NOT NULL,
	"code" text NOT NULL,
	"join_url" text NOT NULL,
	"callback_token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by_discord_id" text NOT NULL,
	"players" integer NOT NULL,
	"bots" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "matches_callback_token_unique" UNIQUE("callback_token")
);
--> statement-breakpoint
CREATE TABLE "scheduled_announcements" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"game_slug" text,
	"message" text NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"interval_days" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" integer NOT NULL,
	"seat_token" text NOT NULL,
	"discord_user_id" text,
	"display_name" text,
	"placement" integer,
	"winner" boolean,
	"stats" jsonb,
	CONSTRAINT "seats_seat_token_unique" UNIQUE("seat_token")
);
--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;