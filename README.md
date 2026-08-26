# Steward

Discord server-management bot — TypeScript, discord.js v14.
Currently shipped: the `/catan` Meridian game launcher. Moderation, automod,
onboarding, announcements, and audit logging are planned (see the docs).

- Scope + architecture: [docs/BRIEF.md](docs/BRIEF.md)
- Task plan: [docs/PLAN.md](docs/PLAN.md)

## Local run

```bash
npm install
cp .env.example .env   # fill in DISCORD_TOKEN, DISCORD_APP_ID, MERIDIAN_* values
npm run deploy-commands  # register slash commands (set DISCORD_GUILD_ID for instant guild scope)
npm run dev
```

## /catan

`/catan players:<3-8> bots:<0-7>` creates a Meridian match via its
`POST /matches` endpoint and posts an embed with the join link and room code.
Contract: `webdev/meridian/docs/DISCORD-LAUNCH.md`. Needs `MERIDIAN_API_URL`
and `MERIDIAN_LAUNCH_TOKEN` in the environment.

## Tests

```bash
npm test      # vitest, discord.js interactions mocked
npm run lint  # tsc --noEmit
```
