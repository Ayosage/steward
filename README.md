# Steward

Discord game platform bot — TypeScript, discord.js v14, Postgres via Drizzle.
Steward launches games from a registry (`/play` + a Join button that hands each
player a personal seat link), receives result webhooks from games, and keeps
per-server stats, leaderboards, game roles, and game-night announcements.
Any game implementing the adapter contract can join the library:
[docs/GAME-ADAPTER.md](docs/GAME-ADAPTER.md).

- Scope + architecture: [docs/BRIEF.md](docs/BRIEF.md)
- Design spec: [docs/superpowers/specs/2026-08-26-steward-game-platform-design.md](docs/superpowers/specs/2026-08-26-steward-game-platform-design.md)

## Commands

Playing:
- `/play game:<slug>` — generic launcher (autocompleted registry); the host sets players and bots in the game's web lobby
- `/catan` — alias for `/play game:catan` (CATAN on Meridian)
- `/wordy` — alias for `/play game:wordy` (Wordy Champions, PvP Wordle for 2 to 8)
- **Join button** — ephemeral personal seat link (mints or reuses your seat)
- `/games` — the library: name, player range, role mention if configured

Stats:
- `/stats [user] [game]` — games, wins, win rate per game
- `/leaderboard game:<slug>` — top players by wins (win-rate tiebreak)

Management (admin = Manage Server):
- `/config match-log channel:<#channel>` — archive channel for result embeds
- `/roles setup` — create game roles + post the self-assign menu
- `/gamenight schedule|list|cancel` — recurring announcements that ping the game role

## Local run

```bash
npm install
cp .env.example .env     # fill in DISCORD_TOKEN, DISCORD_APP_ID, DATABASE_URL, game tokens
npm run db:migrate       # apply drizzle migrations to Postgres
npm run deploy-commands  # register slash commands (set DISCORD_GUILD_ID for instant guild scope)
npm run dev
```

Env vars (see `.env.example`): `DISCORD_TOKEN`, `DISCORD_APP_ID`,
`DISCORD_GUILD_ID` (optional), `DATABASE_URL`, `WEBHOOK_PORT`,
`PUBLIC_BASE_URL`, plus per-game launch settings (`MERIDIAN_API_URL`,
`MERIDIAN_LAUNCH_TOKEN`, `WORDY_API_URL`, `WORDY_LAUNCH_TOKEN`).

Note: `/roles setup` needs the bot to have Manage Roles and its own role
positioned **above** the game roles it creates, or role toggling will fail.

## Deploy

Fly.io: `docs/DEPLOY.md` covers the app, database, secrets, invite link and
the automatic slash-command registration. `npm run build && npm start` runs
the compiled bot the way the container does (after `npm run migrate`).

## Tests

```bash
npm test      # vitest; DB tests run on in-process Postgres (PGlite), Discord mocked
npm run lint  # tsc --noEmit
```
