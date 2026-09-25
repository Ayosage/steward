# Deploying Steward to Fly.io

Steward is one long-running Node process: the Discord gateway client plus an
HTTP server (`WEBHOOK_PORT`, default 8787) that receives game result webhooks
and answers `GET /healthz`. `fly.toml` runs it as a single always-on machine in
`ewr`; `Dockerfile` builds it; `docker-entrypoint.sh` applies pending
`drizzle/` migrations on every start, so there is no separate migrate step.

## 0. Prerequisites

- [flyctl](https://fly.io/docs/flyctl/install/) installed, `fly auth login` done.
- A Discord application with a bot user (Developer Portal > Bot). You need the
  **bot token** and the **application id** (General Information > Application ID).
- The Meridian server deployed (`meridian-server` on Fly) with its `LAUNCH_TOKEN`
  secret set. Steward's `MERIDIAN_LAUNCH_TOKEN` must be the same value.

## 1. Create the app (no deploy yet)

From the repo root:

```bash
fly auth login
fly launch --no-deploy --copy-config --name steward-bot --region ewr
```

`--copy-config` keeps the committed `fly.toml` (autostop off, one machine,
health check on `/healthz`). Answer **no** if it offers to create a Postgres
or Redis for you; the database is set up next so the connection string is
explicit.

## 2. Database

Option A, Neon (free plan, no card; this is what production uses, project
`steward` in `aws-us-east-1`, created with `neonctl projects create`):

```bash
neonctl connection-string --project-id <id> --pooled   # add ?sslmode=require if absent
fly secrets set --app steward-bot DATABASE_URL='<that string>'
```

Option B, Fly Postgres (about $2/month extra; same private network, no TLS config needed):

```bash
fly postgres create --name steward-db --region ewr --vm-size shared-cpu-1x --initial-cluster-size 1
fly postgres attach steward-db --app steward-bot
```

`attach` sets `DATABASE_URL` as a secret on the app automatically.

Option C, Supabase / any hosted Postgres: create a database, copy its
connection string (pooled, with `?sslmode=require`), then:

```bash
fly secrets set --app steward-bot DATABASE_URL='postgres://user:pass@host/steward?sslmode=require'
```

Migrations run on container start, so a fresh database is fine.

## 3. Secrets

Generate one shared launch token and set it on **both** apps:

```bash
LAUNCH_TOKEN=$(openssl rand -hex 32)
fly secrets set --app meridian-server LAUNCH_TOKEN="$LAUNCH_TOKEN"
fly secrets set --app steward-bot \
  DISCORD_TOKEN='<bot token>' \
  DISCORD_APP_ID='<application id>' \
  MERIDIAN_API_URL='https://meridian-server.fly.dev' \
  MERIDIAN_LAUNCH_TOKEN="$LAUNCH_TOKEN" \
  PUBLIC_BASE_URL='https://steward-bot.fly.dev'
```

`PUBLIC_BASE_URL` is what games are told to call back
(`<PUBLIC_BASE_URL>/webhooks/results`), so it must be the public HTTPS
hostname, not an internal one. `WEBHOOK_PORT` is already set in `fly.toml`.
Leave `DISCORD_GUILD_ID` unset in production (see section 6).

## 4. Deploy

```bash
fly deploy --ha=false
```

`--ha=false` matters: without it the first deploy creates a second machine
"for high availability", and two copies of a gateway bot both answer every
interaction (duplicate replies, a doubled scheduler) and double the bill.
If a second machine ever appears (`fly status`), remove it with
`fly scale count 1 --app steward-bot -y`.

Watch the first boot:

```bash
fly logs --app steward-bot
```

A healthy start looks like:

```
migrations applied (/app/drizzle)
result webhooks on :8787
steward ready as Steward#2707
registered 8 command(s) (global)
```

Then confirm the health check from outside:

```bash
curl https://steward-bot.fly.dev/healthz     # {"ok":true,"db":"ok","discord":"ok"}
fly status --app steward-bot                 # one machine, state "started", checks passing
```

`db` is the outcome of the last real query, not a probe. The health check never
touches the database, and the scheduler sleeps until the next announcement
(rescanning at most every 6 h), so an idle bot lets Neon suspend after its
5 minute timeout. Confirm it is actually sleeping a day after a deploy:

```bash
neonctl api /projects/<project-id>/endpoints | grep -E 'current_state|last_active'
# "current_state": "idle" most of the day; active_time on the project should barely move
```

A `select 1` on a timer, a metrics scraper, or anything polling the database
brings the compute-hour burn back; before this change the bot polled every
30 s and used ~95% of the month's compute hours while idle.

## 5. Invite the bot to a server

Open this URL (replace the id) in a browser while logged into Discord with an
account that can manage the target server:

```
https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot%20applications.commands&permissions=268437504
```

Permission value 268437504 = Manage Roles + Send Messages + View Channels,
which `/roles setup` and the result/announcement posting need. After inviting,
move the bot's role **above** the game roles it creates or role toggling fails.

## 6. Slash commands register themselves

On every startup, after the gateway `ready` event, Steward PUTs its full
command list to Discord (`src/register-commands.ts`). With no
`DISCORD_GUILD_ID` set the registration is **global**: commands appear in
every server the bot is in, including servers that invite it later, with up to
an hour of propagation the first time. Nothing else has to run after
`fly deploy`.

For local iteration set `DISCORD_GUILD_ID=<your test server id>` in `.env`;
guild-scoped registration is instant. Do not set it on Fly, or production
commands would only exist in that one guild.

## 7. Day-to-day

```bash
fly deploy                      # ship a new build (migrations run on boot)
fly logs --app steward-bot          # tail logs
fly ssh console --app steward-bot   # shell into the machine
fly secrets list --app steward-bot  # names only, values are never shown
fly scale memory 512 --app steward-bot   # if the 256 MB default gets tight
```

Rolling back: `fly releases --app steward-bot` then `fly deploy --image <previous image ref>`.

## Local Docker check

```bash
docker build -t steward .
docker run --rm --env-file .env -p 8787:8787 steward
curl localhost:8787/healthz
```

The container needs a reachable `DATABASE_URL`; on macOS, point it at the host
with `host.docker.internal` instead of `localhost`.
