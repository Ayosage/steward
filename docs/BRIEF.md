# Steward — Project Brief

**What:** A Discord server-management bot: moderation, onboarding, roles,
announcements, and audit logging. Portfolio purpose: demonstrate backend/API
engineering — event-driven architecture, third-party API integration, stateful
services, deployment.

**Stack:** TypeScript, discord.js v14 (slash commands + gateway events),
Postgres + Drizzle, Node 20. Deployed later to Railway/Fly (out of scope until
features exist). Vitest for tests; discord.js interactions mocked in unit tests.

## Features (v1)

- **Moderation:** `/warn`, `/mute`, `/ban` with reason + duration; warning
  thresholds trigger escalation; all actions logged.
- **Automod:** configurable word/link filters, spam rate-limiting (message
  frequency per user), action = delete + warn.
- **Onboarding:** welcome message, role-menu (select-menu based self-assign
  roles), configurable per guild.
- **Announcements:** `/announce schedule` — scheduled messages via a DB-backed
  job table (no external queue).
- **Audit log:** every bot action + message deletions/edits mirrored to a
  configured log channel and stored in Postgres.
- **Per-guild config:** `/config` commands store settings in DB; bot is
  multi-guild from day one.

## Non-goals (v1)

- Web dashboard (post-v1 candidate).
- Music/leveling/economy features.

## Architecture notes

- Command handler pattern: each command in its own file exporting
  `{ data: SlashCommandBuilder, execute(interaction) }`; loader registers all.
- Event handlers likewise one file per gateway event.
- All state in Postgres — the bot process is disposable/restartable.
