CREATE TABLE "lobbies" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"game_slug" text NOT NULL,
	"host_discord_id" text NOT NULL,
	"bots" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"match_id" integer,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lobby_members" (
	"lobby_id" integer NOT NULL,
	"discord_user_id" text NOT NULL,
	"display_name" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lobby_members_lobby_id_discord_user_id_pk" PRIMARY KEY("lobby_id","discord_user_id")
);
--> statement-breakpoint
ALTER TABLE "lobbies" ADD CONSTRAINT "lobbies_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lobby_members" ADD CONSTRAINT "lobby_members_lobby_id_lobbies_id_fk" FOREIGN KEY ("lobby_id") REFERENCES "public"."lobbies"("id") ON DELETE no action ON UPDATE no action;