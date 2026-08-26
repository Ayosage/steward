# Steward — Task Plan

Rules: work top to bottom, one task per PR, Vitest tests written first and
passing before PR. Never commit tokens; bot token comes from `DISCORD_TOKEN`
env var (document in `.env.example`).

- [ ] Scaffold: TypeScript + Node 20 project, discord.js v14, ESLint/Prettier, Vitest, `.env.example`, README with local-run instructions
- [ ] Command + event handler loaders: auto-register files from `src/commands/` and `src/events/`; unit tests with mocked client
- [ ] Drizzle + Postgres setup: `guild_configs`, `warnings`, `mod_actions`, `scheduled_messages` tables + migrations; test DB via docker-compose
- [ ] `/config` command group: set log channel, automod toggles, welcome channel; persisted per guild
- [ ] `/warn` with reason; warning count query; threshold escalation (3 warns → timeout) with tests
- [ ] `/mute` (timeout) and `/ban` with duration parsing (`10m`, `2h`, `7d`) + tests for the parser
- [ ] Audit log module: helper that mirrors any mod action to log channel + `mod_actions` table; wire into warn/mute/ban
- [ ] Automod: word/link filter from guild config on messageCreate; delete + auto-warn; unit tests on the matcher
- [ ] Automod: spam rate-limit (sliding window per user) + tests on the window logic
- [ ] Onboarding: welcome message on guildMemberAdd + `/rolemenu create` select-menu role self-assignment
- [ ] `/announce schedule`: store in `scheduled_messages`, polling dispatcher loop + tests with fake timers
- [ ] Message edit/delete mirroring to log channel
- [ ] `/catan` game launcher: create a Meridian match via its `POST /matches` endpoint and post an embed with the join link — contract in `webdev/meridian/docs/DISCORD-LAUNCH.md` (env: `MERIDIAN_API_URL`, `MERIDIAN_LAUNCH_TOKEN`)
