# Steward — Discord Game Platform (design)

2026-08-26. Supersedes the server-management scope of `docs/BRIEF.md`.

## What Steward becomes

A Discord game platform: a library of our own games (Meridian/CATAN first)
launchable from Discord, with victory tracking and per-guild stats, plus
light game-adjacent server management. Moderation/automod are dropped from
scope.

**v1 pillars**

1. **Game library + launching** — a generic game-adapter contract; any
   conforming game slots into the library via static config.
2. **Victory & stats tracking** — games push signed result webhooks;
   Steward credits Discord users via per-player seat tokens; `/stats` and
   `/leaderboard` per guild.
3. **Game-adjacent management** — self-assign game roles, a match-log
   channel, scheduled game-night announcements.

**Architecture shape (approach A):** one Node process — the discord.js v14
gateway bot plus a small HTTP server for result webhooks — over Postgres +
Drizzle. Game registry is a static config module, not a DB table: games
enter the library when we build one, which is a code change anyway.

## The game-adapter contract (v1)

Lives here as `docs/GAME-ADAPTER.md` once implemented; Meridian's
`DISCORD-LAUNCH.md` (v0) will point at it and keep only Catan-specific
notes. Three pieces:

### 1. Launch — Steward → game

```
POST <game.launchUrl>/matches
Authorization: Bearer <per-game LAUNCH_TOKEN>

{
  "players": 4,
  "bots": 0,
  "seats": [{ "seatToken": "st_...", "displayName": "Alice" }],   // optional
  "callback": { "url": "https://<steward>/webhooks/results", "token": "cb_..." }
}
```

Response unchanged from v0: `201` with `{ code, joinUrl, expiresAt }`;
errors `401` / `422` / `503`. `callback` is minted per match: a random
token Steward later uses to authenticate the result webhook. No shared
secrets, no HMAC; the game echoes what it was given. `seats` at launch is
optional/vestigial (v0-style cosmetic pre-naming); identity binding happens
via join links.

### 2. Per-player join links

The Discord match embed carries a **Join** button. Clicking it mints a
`seatToken` bound to the clicker's Discord ID and replies ephemerally with
their personal link: `<joinUrl>&seat=<seatToken>`. The game learns the
token when the player arrives — no second Steward→game sync call, late
joiners work naturally. Tokens are opaque to the game; it binds token →
seat and labels the seat with the display name. Bare-code joins (no token)
still play; those seats report anonymously and earn no stats. Clicking
Join twice returns the same link, not a second seat.

### 3. Results — game → Steward

```
POST <callback.url>
Authorization: Bearer <callback.token>

{
  "code": "ABCD",
  "status": "completed" | "abandoned",
  "seats": [
    { "seatToken": "st_...", "displayName": "Alice", "placement": 1,
      "winner": true, "stats": { "vp": 10, "longestRoad": true } }
  ]
}
```

Sent when the game ends, or best-effort on abandonment/expiry. `seatToken`
is absent for anonymous seats. `stats` is a free-form per-game extras blob:
stored and rendered on the result embed, never aggregated in v1. Webhooks
are idempotent — seats upsert by token, first transition to `completed`
wins and posts embeds.

## Data model (Postgres + Drizzle)

Stats are derived, never stored.

- **`matches`** — `id` pk, `guildId`, `channelId` (result embed target),
  `gameSlug`, `code`, `joinUrl`, `callbackToken`, `status`
  (`pending → active → completed | abandoned | expired`),
  `createdByDiscordId`, `createdAt`, `expiresAt`, `finishedAt`.
- **`seats`** — `id`, `matchId` fk, `seatToken` unique, `discordUserId`
  (null = anonymous), `displayName`, `placement`, `winner` bool, `stats`
  jsonb.
- **`guild_config`** — `guildId` pk, `matchLogChannelId`.
- **`game_roles`** — `guildId`, `gameSlug`, `roleId` (self-assign role
  menu; powers game pings).
- **`scheduled_announcements`** — `id`, `guildId`, `channelId`,
  `gameSlug?`, `nextRunAt` + recurrence, `message`, `enabled`.

`/stats` and `/leaderboard` are aggregation queries over `seats ⋈ matches`
where `status = 'completed'`, grouped by `(guildId, gameSlug,
discordUserId)`. If ever slow, a materialized view drops in without
touching the write path.

**Registry (static config):** `src/games.ts` exporting per game:
`{ slug, name, launchUrl, tokenEnvVar, minPlayers, maxPlayers, maxBots }`.
First entry: Meridian/CATAN (players 3–8).

**Lifecycle:** `pending` → `active` on first Join click. A poll-loop sweep
marks matches past `expiresAt` as `expired`; a late `completed` webhook
still wins over `expired` (the game is the source of truth, the sweep is a
guess).

## Command surface

Playing:
- `/play game:<slug> players:<n> bots:<n>` — generic launcher; `game`
  autocompleted from registry; per-game bounds validated. Posts match
  embed: game, room code, expiry countdown, **Join** button.
- `/catan players:<n> bots:<n>` — kept as an alias over the same path.
- **Join button** → ephemeral personal join link (mints/reuses seat).
- `/games` — the library: name, player range, role mention if configured.

Stats:
- `/stats [user] [game]` — defaults caller/all games: games, wins, win
  rate, per-game breakdown.
- `/leaderboard game:<slug>` — top players by wins (win-rate tiebreak),
  current guild only.

Management (admin = Manage Server):
- `/gamenight schedule|list|cancel` — scheduled announcements; poll loop
  posts and pings the game's role.
- `/config match-log channel:<#channel>` — archive channel for result
  embeds (results always post to the launch channel too).
- `/roles setup` — posts a select-menu mapping registry games to guild
  roles for self-assignment.

Inbound: result webhook → result embed in the match's channel (winner,
placements, compact `stats` rendering), mirrored to match-log if set.

## Meridian-side changes (separate task, in Meridian's plan)

Steward is built against a mocked game; none of this blocks it.

1. `POST /matches` accepts/stores `callback` and tokenized `seats`.
2. `?seat=` claim path: client passes the param into the room join; room
   binds token → seat. Unknown/duplicate tokens ignored gracefully (player
   seats anonymously). Tokens never inspected.
3. Result reporting on game end: POST to stored callback with bearer
   token; Catan `stats` blob (VP, longest road, largest army). ~3 attempts
   with backoff; fire-and-forget — a dead Steward never affects the game.
   No callback stored → no POST (lobby-created rooms unchanged).
4. Best-effort `status: "abandoned"` when a launched room disposes
   unfinished; Steward's expiry sweep remains the backstop.

## Error handling

- **Launch:** match row created only after the game's `201` — failed
  launches leave no state. Game errors map to friendly ephemeral replies;
  `401` also logs a config error.
- **Webhook:** unknown code `404`; bad token `401`; malformed (zod) `422`.
  Persist then `2xx` immediately; Discord embed posting is best-effort
  after — a Discord outage never makes the game retry.
- **Interactions:** Join on a closed match → ephemeral "match is closed".
  Deleted channels/roles → skip and log. Poll loop wraps each job so one
  bad row can't stall the rest.

## Testing

vitest + `tsc --noEmit`, extending the existing mocked-interaction pattern:

- **Unit:** command handlers vs mocked interactions; registry validation;
  seat-token mint/reuse.
- **Webhook:** in-process HTTP tests — auth, idempotency/duplicates,
  anonymous seats, expired-then-completed policy, stats passthrough.
- **DB:** PGlite (in-process Postgres, no Docker) — focused on the
  stats/leaderboard aggregations: win-rate math, guild scoping, excluding
  abandoned matches.
- **Integration:** one end-to-end spec: `/play` vs mocked game → Join →
  result webhook → assert result embed + stats.

## Non-goals (v1)

Ratings (Elo/TrueSkill), cross-guild/global stats, third-party game
wrappers, dynamic game registration, moderation/automod, web dashboard,
extras-blob aggregation. All possible later; none constrain v1.
