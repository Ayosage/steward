# Steward Game Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Steward into a Discord game platform: a generic game launcher (`/play` + Join-button seat links), result webhooks with per-guild stats/leaderboards, and light game-adjacent management (roles, match-log, game nights).

**Architecture:** One Node process: the existing discord.js v14 gateway bot plus a small `node:http` webhook server, over Postgres via Drizzle. The game registry is a static config module (`src/games.ts`). Steward is built entirely against a mocked game — no Meridian changes are required for any task here. Services take a `Db` handle and injectable dependencies (the codebase's existing deps-injection pattern) so everything is unit-testable; DB tests run on PGlite (in-process Postgres, no Docker).

**Tech Stack:** TypeScript (strict, ESM/NodeNext), discord.js ^14.16, drizzle-orm + pg (prod) / @electric-sql/pglite (tests), drizzle-kit migrations, zod, vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-08-26-steward-game-platform-design.md`

## Global Constraints

- TypeScript strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — code must pass `npm run lint` (`tsc --noEmit`) at every commit.
- ESM with NodeNext resolution: **all relative imports use `.js` extensions** (e.g. `from './games.js'`), including in tests.
- Stats are derived, never stored — no denormalized counters anywhere.
- Match rows are created only after the game's `201` — failed launches leave no state.
- Webhook handling: persist then `2xx` immediately; Discord posting is best-effort afterwards.
- All user-facing error replies are ephemeral (`flags: MessageFlags.Ephemeral`); match embeds and results are public.
- Non-goals (do NOT build): ratings, cross-guild stats, dynamic game registration, moderation, web dashboard, extras-blob aggregation.
- Commit after every task with a conventional-commit message.

## File Structure (end state)

```
drizzle/                     # generated SQL migrations (committed)
drizzle.config.ts
src/
  index.ts                   # wiring: client, router, webhook server, scheduler
  deploy-commands.ts         # unchanged
  games.ts                   # static game registry + launch validation
  game-client.ts             # generic Steward→game launch HTTP client
  tokens.ts                  # seat/callback token minting
  matches.ts                 # launchMatch, mintSeat, personalJoinUrl
  results.ts                 # webhook payload schema + idempotent processing
  webhook-server.ts          # node:http POST /webhooks/results
  result-poster.ts           # result embed → launch channel + match-log mirror
  embeds.ts                  # match embed, Join row, result embed
  stats.ts                   # playerStats + leaderboard aggregations
  scheduler.ts               # expiry sweep + game-night announcements poll loop
  db/
    index.ts                 # Db type, createDb, getDb singleton
    schema.ts                # matches, seats, guild_config, game_roles, scheduled_announcements
  commands/
    index.ts                 # Command interface + registry map
    play.ts                  # /play (generic launcher, autocomplete) + runPlay
    catan.ts                 # /catan alias over runPlay
    games.ts                 # /games library listing
    stats.ts                 # /stats
    leaderboard.ts           # /leaderboard
    config.ts                # /config match-log
    roles.ts                 # /roles setup
    gamenight.ts             # /gamenight schedule|list|cancel
  interactions/
    join.ts                  # Join button handler
    roles.ts                 # role select-menu handler
test/
  helpers/db.ts              # PGlite test database factory
  db.test.ts, games.test.ts, game-client.test.ts, matches.test.ts,
  seats.test.ts, embeds.test.ts, play-command.test.ts, join-button.test.ts,
  results.test.ts, webhook-server.test.ts, stats.test.ts,
  config-command.test.ts, result-poster.test.ts, roles.test.ts,
  scheduler.test.ts, gamenight.test.ts, e2e.test.ts
docs/GAME-ADAPTER.md         # the v1 adapter contract (published form)
```

`src/meridian.ts` and `test/meridian.test.ts` are deleted in Task 7 (replaced by `game-client.ts`).

---

### Task 1: Database foundation (Drizzle schema, migrations, PGlite test harness)

**Files:**
- Create: `src/db/schema.ts`, `src/db/index.ts`, `drizzle.config.ts`, `test/helpers/db.ts`
- Test: `test/db.test.ts`
- Modify: `package.json` (deps + `db:generate`/`db:migrate` scripts)

**Interfaces:**
- Consumes: nothing.
- Produces: `Db` type, `createDb(connectionString): Db`, `getDb(): Db`; tables `matches`, `seats`, `guildConfig`, `gameRoles`, `scheduledAnnouncements`; row types `MatchRow`, `SeatRow`; test helper `testDb(): Promise<Db>`.

Note two deliberate additions vs the spec's table sketch: `matches.players` and `matches.bots` (needed to render the embed and cap Join minting — the spec's command surface requires them).

- [x] **Step 1: Install dependencies**

```bash
npm i drizzle-orm pg zod
npm i -D drizzle-kit @electric-sql/pglite @types/pg
```

- [x] **Step 2: Write the failing test**

```ts
// test/db.test.ts
import { describe, expect, it } from 'vitest'
import { matches, seats } from '../src/db/schema.js'
import { testDb } from './helpers/db.js'

describe('db schema', () => {
  it('inserts and reads a match with a seat; status defaults to pending', async () => {
    const db = await testDb()
    const [m] = await db
      .insert(matches)
      .values({
        guildId: 'g1',
        channelId: 'c1',
        gameSlug: 'catan',
        code: 'ABCD',
        joinUrl: 'http://play.example/?join=ABCD',
        callbackToken: 'cb_x',
        createdByDiscordId: 'u1',
        players: 4,
        bots: 0,
        expiresAt: new Date('2026-08-27T12:00:00Z'),
      })
      .returning()
    expect(m!.status).toBe('pending')
    await db.insert(seats).values({ matchId: m!.id, seatToken: 'st_a', discordUserId: 'u1', displayName: 'Ayo' })
    const rows = await db.select().from(seats)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.stats).toBeNull()
  })

  it('rejects duplicate seat tokens', async () => {
    const db = await testDb()
    const [m] = await db
      .insert(matches)
      .values({
        guildId: 'g1', channelId: 'c1', gameSlug: 'catan', code: 'EFGH',
        joinUrl: 'http://play.example/?join=EFGH', callbackToken: 'cb_y',
        createdByDiscordId: 'u1', players: 4, bots: 0,
      })
      .returning()
    await db.insert(seats).values({ matchId: m!.id, seatToken: 'st_dup' })
    await expect(db.insert(seats).values({ matchId: m!.id, seatToken: 'st_dup' })).rejects.toThrow()
  })
})
```

- [x] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/db.test.ts`
Expected: FAIL — cannot resolve `../src/db/schema.js` / `./helpers/db.js`.

- [x] **Step 4: Write schema, db module, config, and test helper**

```ts
// src/db/schema.ts
import { boolean, integer, jsonb, pgTable, primaryKey, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const matches = pgTable('matches', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  channelId: text('channel_id').notNull(), // result embed target (launch channel)
  gameSlug: text('game_slug').notNull(),
  code: text('code').notNull(),
  joinUrl: text('join_url').notNull(),
  callbackToken: text('callback_token').notNull().unique(),
  status: text('status', { enum: ['pending', 'active', 'completed', 'abandoned', 'expired'] })
    .notNull()
    .default('pending'),
  createdByDiscordId: text('created_by_discord_id').notNull(),
  players: integer('players').notNull(),
  bots: integer('bots').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
})

export const seats = pgTable('seats', {
  id: serial('id').primaryKey(),
  matchId: integer('match_id')
    .notNull()
    .references(() => matches.id),
  seatToken: text('seat_token').notNull().unique(),
  discordUserId: text('discord_user_id'), // null = anonymous seat
  displayName: text('display_name'),
  placement: integer('placement'),
  winner: boolean('winner'),
  stats: jsonb('stats'),
})

export const guildConfig = pgTable('guild_config', {
  guildId: text('guild_id').primaryKey(),
  matchLogChannelId: text('match_log_channel_id'),
})

export const gameRoles = pgTable(
  'game_roles',
  {
    guildId: text('guild_id').notNull(),
    gameSlug: text('game_slug').notNull(),
    roleId: text('role_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.gameSlug] })],
)

export const scheduledAnnouncements = pgTable('scheduled_announcements', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  channelId: text('channel_id').notNull(),
  gameSlug: text('game_slug'), // null = generic announcement, no role ping
  message: text('message').notNull(),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
  intervalDays: integer('interval_days').notNull(),
  enabled: boolean('enabled').notNull().default(true),
})

export type MatchRow = typeof matches.$inferSelect
export type SeatRow = typeof seats.$inferSelect
export type AnnouncementRow = typeof scheduledAnnouncements.$inferSelect
```

```ts
// src/db/index.ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

export type Db = NodePgDatabase<typeof schema>

export function createDb(connectionString: string): Db {
  return drizzle(new pg.Pool({ connectionString }), { schema })
}

let singleton: Db | undefined

/** Process-wide handle for command default-deps. Tests always inject their own. */
export function getDb(): Db {
  if (!singleton) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set (see .env.example)')
    singleton = createDb(url)
  }
  return singleton
}
```

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
})
```

```ts
// test/helpers/db.ts
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { Db } from '../../src/db/index.js'
import * as schema from '../../src/db/schema.js'

/** Fresh in-process Postgres with migrations applied. One per test (or per file). */
export async function testDb(): Promise<Db> {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: 'drizzle' })
  // PgliteDatabase and NodePgDatabase share the query API; services only see `Db`.
  return db as unknown as Db
}
```

Add scripts to `package.json` (`"scripts"` block):

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate"
```

- [x] **Step 5: Generate the initial migration**

Run: `npm run db:generate`
Expected: a new SQL file under `drizzle/` (plus `drizzle/meta/`). Open it and confirm it creates all five tables.

- [x] **Step 6: Run tests and lint to verify they pass**

Run: `npx vitest run test/db.test.ts && npm run lint`
Expected: 2 PASS, tsc clean.

- [x] **Step 7: Commit**

```bash
git add package.json package-lock.json drizzle.config.ts drizzle src/db test/helpers/db.ts test/db.test.ts
git commit -m "feat: postgres schema via drizzle + pglite test harness"
```

---

### Task 2: Game registry

**Files:**
- Create: `src/games.ts`
- Test: `test/games.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface GameDef { slug: string; name: string; launchUrl: string; tokenEnvVar: string; minPlayers: number; maxPlayers: number; maxBots: number; defaultPlayers: number }`; `games: readonly GameDef[]`; `getGame(slug: string): GameDef | undefined`; `validateLaunch(game: GameDef, players: number, bots: number): string | null`.

- [x] **Step 1: Write the failing test**

```ts
// test/games.test.ts
import { describe, expect, it } from 'vitest'
import { games, getGame, validateLaunch } from '../src/games.js'

describe('game registry', () => {
  it('has catan as its first entry with 3-8 players', () => {
    expect(games[0]!.slug).toBe('catan')
    expect(games[0]!.minPlayers).toBe(3)
    expect(games[0]!.maxPlayers).toBe(8)
    expect(getGame('catan')).toBe(games[0])
    expect(getGame('nope')).toBeUndefined()
  })

  it('validates player and bot bounds', () => {
    const catan = getGame('catan')!
    expect(validateLaunch(catan, 4, 0)).toBeNull()
    expect(validateLaunch(catan, 2, 0)).toMatch(/players must be 3\.\.8/)
    expect(validateLaunch(catan, 9, 0)).toMatch(/players must be 3\.\.8/)
    expect(validateLaunch(catan, 4, 4)).toMatch(/bots must be 0\.\.3/)
    expect(validateLaunch(catan, 4, -1)).toMatch(/bots must be 0\.\.3/)
    expect(validateLaunch(catan, 8, 7)).toBeNull()
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/games.test.ts`
Expected: FAIL — cannot resolve `../src/games.js`.

- [x] **Step 3: Write the implementation**

```ts
// src/games.ts
/** Static game registry: games enter the library when we build one (a code change anyway). */
export interface GameDef {
  slug: string
  name: string
  launchUrl: string
  tokenEnvVar: string
  minPlayers: number
  maxPlayers: number
  maxBots: number
  defaultPlayers: number
}

export const games: readonly GameDef[] = [
  {
    slug: 'catan',
    name: 'CATAN (Meridian)',
    launchUrl: process.env.MERIDIAN_API_URL ?? 'http://localhost:2567',
    tokenEnvVar: 'MERIDIAN_LAUNCH_TOKEN',
    minPlayers: 3,
    maxPlayers: 8,
    maxBots: 7,
    defaultPlayers: 4,
  },
]

export function getGame(slug: string): GameDef | undefined {
  return games.find((g) => g.slug === slug)
}

/** Returns a user-facing error message, or null when the launch parameters are valid. */
export function validateLaunch(game: GameDef, players: number, bots: number): string | null {
  if (players < game.minPlayers || players > game.maxPlayers)
    return `players must be ${game.minPlayers}..${game.maxPlayers}`
  const maxBots = Math.min(game.maxBots, players - 1)
  if (bots < 0 || bots > maxBots) return `bots must be 0..${maxBots}`
  return null
}
```

- [x] **Step 4: Run tests and lint to verify they pass**

Run: `npx vitest run test/games.test.ts && npm run lint`
Expected: PASS, tsc clean.

- [x] **Step 5: Commit**

```bash
git add src/games.ts test/games.test.ts
git commit -m "feat: static game registry with launch validation"
```

---

### Task 3: Generic game launch client

**Files:**
- Create: `src/game-client.ts`
- Test: `test/game-client.test.ts`

**Interfaces:**
- Consumes: `GameDef` from Task 2.
- Produces: `interface LaunchBody { players: number; bots: number; callback: { url: string; token: string } }`; `interface LaunchedMatch { code: string; joinUrl: string; expiresAt: string }`; `class GameLaunchError extends Error`; `createGameMatch(game: GameDef, body: LaunchBody, fetchFn?: typeof fetch): Promise<LaunchedMatch>`.

This generalizes `src/meridian.ts` (leave meridian.ts in place until Task 7 so `/catan` keeps compiling). The v1 body drops `seatNames` and adds the per-match `callback` (spec: seats-at-launch is vestigial; identity binding happens via join links).

- [x] **Step 1: Write the failing test**

```ts
// test/game-client.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createGameMatch, GameLaunchError } from '../src/game-client.js'
import type { GameDef } from '../src/games.js'

const GAME: GameDef = {
  slug: 'catan', name: 'CATAN (Meridian)', launchUrl: 'http://game.example',
  tokenEnvVar: 'TEST_LAUNCH_TOKEN', minPlayers: 3, maxPlayers: 8, maxBots: 7, defaultPlayers: 4,
}
const BODY = { players: 4, bots: 1, callback: { url: 'http://steward.example/webhooks/results', token: 'cb_t' } }

function okFetch(body: unknown, status = 201) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

describe('createGameMatch', () => {
  it('POSTs the v1 body with the bearer token from the game env var', async () => {
    process.env.TEST_LAUNCH_TOKEN = 'sekrit'
    const fetchFn = okFetch({ code: 'ABCD', joinUrl: 'http://play.example/?join=ABCD', expiresAt: '2026-08-27T12:00:00Z' })
    const match = await createGameMatch(GAME, BODY, fetchFn)
    expect(match.code).toBe('ABCD')
    expect(fetchFn).toHaveBeenCalledWith('http://game.example/matches', {
      method: 'POST',
      headers: { authorization: 'Bearer sekrit', 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    })
  })

  it('throws GameLaunchError carrying the server message on non-201', async () => {
    const fetchFn = okFetch({ error: 'players must be 3..8' }, 422)
    await expect(createGameMatch(GAME, BODY, fetchFn)).rejects.toThrow(GameLaunchError)
    await expect(createGameMatch(GAME, BODY, fetchFn)).rejects.toThrow(/players must be 3\.\.8/)
  })

  it('wraps network failures in GameLaunchError', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(createGameMatch(GAME, BODY, fetchFn)).rejects.toThrow(GameLaunchError)
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/game-client.test.ts`
Expected: FAIL — cannot resolve `../src/game-client.js`.

- [x] **Step 3: Write the implementation**

```ts
// src/game-client.ts
/**
 * Generic Steward→game launch client. Contract: docs/GAME-ADAPTER.md (v1).
 */
import type { GameDef } from './games.js'

export interface LaunchCallback {
  url: string
  token: string
}

export interface LaunchBody {
  players: number
  bots: number
  callback: LaunchCallback
}

export interface LaunchedMatch {
  code: string
  joinUrl: string
  expiresAt: string
}

export class GameLaunchError extends Error {}

export async function createGameMatch(
  game: GameDef,
  body: LaunchBody,
  fetchFn: typeof fetch = fetch,
): Promise<LaunchedMatch> {
  const token = process.env[game.tokenEnvVar] ?? ''
  let res: Response
  try {
    res = await fetchFn(`${game.launchUrl}/matches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new GameLaunchError(`could not reach the game server: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status !== 201) {
    let detail = `HTTP ${res.status}`
    try {
      const parsed = (await res.json()) as { error?: string }
      if (parsed.error) detail = parsed.error
    } catch {
      // non-JSON error body: keep the status text
    }
    if (res.status === 401) console.error(`[games] launch token rejected for ${game.slug} — check ${game.tokenEnvVar}`)
    throw new GameLaunchError(detail)
  }
  return (await res.json()) as LaunchedMatch
}
```

- [x] **Step 4: Run tests and lint to verify they pass**

Run: `npx vitest run test/game-client.test.ts && npm run lint`
Expected: PASS, tsc clean.

- [x] **Step 5: Commit**

```bash
git add src/game-client.ts test/game-client.test.ts
git commit -m "feat: generic game launch client with callback contract"
```

---

### Task 4: Token minting and match launch service

**Files:**
- Create: `src/tokens.ts`, `src/matches.ts`
- Test: `test/matches.test.ts`

**Interfaces:**
- Consumes: `Db`, `matches` table, `MatchRow` (Task 1); `GameDef` (Task 2); `createGameMatch`, `GameLaunchError`, `LaunchedMatch` (Task 3).
- Produces: `newToken(prefix: string): string`; `interface LaunchMatchArgs { db: Db; game: GameDef; players: number; bots: number; guildId: string; channelId: string; createdByDiscordId: string; publicBaseUrl: string; createMatch?: typeof createGameMatch }`; `launchMatch(args: LaunchMatchArgs): Promise<MatchRow>`.

- [x] **Step 1: Write the failing test**

```ts
// test/matches.test.ts
import { describe, expect, it, vi } from 'vitest'
import { matches } from '../src/db/schema.js'
import { GameLaunchError } from '../src/game-client.js'
import { getGame } from '../src/games.js'
import { launchMatch } from '../src/matches.js'
import { newToken } from '../src/tokens.js'
import { testDb } from './helpers/db.js'

const LAUNCHED = { code: 'ABCD', joinUrl: 'http://play.example/?join=ABCD', expiresAt: '2026-08-27T12:00:00.000Z' }

describe('newToken', () => {
  it('mints prefixed, unique, url-safe tokens', () => {
    const a = newToken('st')
    const b = newToken('st')
    expect(a).toMatch(/^st_[A-Za-z0-9_-]{16,}$/)
    expect(a).not.toBe(b)
  })
})

describe('launchMatch', () => {
  it('calls the game with a minted callback and persists the row after 201', async () => {
    const db = await testDb()
    const createMatch = vi.fn(async () => LAUNCHED)
    const row = await launchMatch({
      db, game: getGame('catan')!, players: 4, bots: 1,
      guildId: 'g1', channelId: 'c1', createdByDiscordId: 'u1',
      publicBaseUrl: 'http://steward.example', createMatch,
    })
    const body = createMatch.mock.calls[0]![1] as { callback: { url: string; token: string } }
    expect(body.callback.url).toBe('http://steward.example/webhooks/results')
    expect(body.callback.token).toMatch(/^cb_/)
    expect(row.code).toBe('ABCD')
    expect(row.status).toBe('pending')
    expect(row.callbackToken).toBe(body.callback.token)
    expect(row.expiresAt).toEqual(new Date(LAUNCHED.expiresAt))
  })

  it('leaves no row when the game launch fails', async () => {
    const db = await testDb()
    const createMatch = vi.fn(async () => {
      throw new GameLaunchError('boom')
    })
    await expect(
      launchMatch({
        db, game: getGame('catan')!, players: 4, bots: 0,
        guildId: 'g1', channelId: 'c1', createdByDiscordId: 'u1',
        publicBaseUrl: 'http://steward.example', createMatch,
      }),
    ).rejects.toThrow(GameLaunchError)
    expect(await db.select().from(matches)).toHaveLength(0)
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/matches.test.ts`
Expected: FAIL — cannot resolve `../src/tokens.js` / `../src/matches.js`.

- [x] **Step 3: Write the implementation**

```ts
// src/tokens.ts
import { randomBytes } from 'node:crypto'

/** Opaque url-safe token, e.g. `st_...` (seats) or `cb_...` (result callbacks). */
export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString('base64url')}`
}
```

```ts
// src/matches.ts
import type { Db } from './db/index.js'
import { matches, type MatchRow } from './db/schema.js'
import { createGameMatch } from './game-client.js'
import type { GameDef } from './games.js'
import { newToken } from './tokens.js'

export interface LaunchMatchArgs {
  db: Db
  game: GameDef
  players: number
  bots: number
  guildId: string
  channelId: string
  createdByDiscordId: string
  publicBaseUrl: string
  createMatch?: typeof createGameMatch
}

/** Launch via the game adapter; the match row exists only after the game's 201. */
export async function launchMatch(args: LaunchMatchArgs): Promise<MatchRow> {
  const create = args.createMatch ?? createGameMatch
  const callbackToken = newToken('cb')
  const launched = await create(args.game, {
    players: args.players,
    bots: args.bots,
    callback: { url: `${args.publicBaseUrl}/webhooks/results`, token: callbackToken },
  })
  const [row] = await args.db
    .insert(matches)
    .values({
      guildId: args.guildId,
      channelId: args.channelId,
      gameSlug: args.game.slug,
      code: launched.code,
      joinUrl: launched.joinUrl,
      callbackToken,
      createdByDiscordId: args.createdByDiscordId,
      players: args.players,
      bots: args.bots,
      expiresAt: new Date(launched.expiresAt),
    })
    .returning()
  return row!
}
```

- [x] **Step 4: Run tests and lint to verify they pass**

Run: `npx vitest run test/matches.test.ts && npm run lint`
Expected: PASS, tsc clean.

- [x] **Step 5: Commit**

```bash
git add src/tokens.ts src/matches.ts test/matches.test.ts
git commit -m "feat: launchMatch service with per-match callback tokens"
```

---

### Task 5: Seat minting (Join semantics)

**Files:**
- Modify: `src/matches.ts`
- Test: `test/seats.test.ts`

**Interfaces:**
- Consumes: Task 4's `matches.ts`, `seats` table, `SeatRow`.
- Produces (added to `src/matches.ts`): `class MatchClosedError extends Error`; `class MatchFullError extends Error`; `personalJoinUrl(joinUrl: string, seatToken: string): string`; `interface MintedSeat { seat: SeatRow; personalUrl: string; reused: boolean }`; `mintSeat(db: Db, match: MatchRow, user: { id: string; displayName: string }): Promise<MintedSeat>`.

- [x] **Step 1: Write the failing test**

```ts
// test/seats.test.ts
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db } from '../src/db/index.js'
import { matches, type MatchRow } from '../src/db/schema.js'
import { MatchClosedError, MatchFullError, mintSeat, personalJoinUrl } from '../src/matches.js'
import { testDb } from './helpers/db.js'

async function seedMatch(db: Db, overrides: Partial<typeof matches.$inferInsert> = {}): Promise<MatchRow> {
  const [m] = await db
    .insert(matches)
    .values({
      guildId: 'g1', channelId: 'c1', gameSlug: 'catan', code: 'ABCD',
      joinUrl: 'http://play.example/?join=ABCD', callbackToken: `cb_${Math.random()}`,
      createdByDiscordId: 'u1', players: 3, bots: 1,
      ...overrides,
    })
    .returning()
  return m!
}

describe('personalJoinUrl', () => {
  it('appends the seat token to an URL that already has a query', () => {
    expect(personalJoinUrl('http://play.example/?join=ABCD', 'st_x')).toBe('http://play.example/?join=ABCD&seat=st_x')
  })
})

describe('mintSeat', () => {
  it('mints a seat bound to the discord user and activates a pending match', async () => {
    const db = await testDb()
    const m = await seedMatch(db)
    const minted = await mintSeat(db, m, { id: 'u2', displayName: 'Alice' })
    expect(minted.reused).toBe(false)
    expect(minted.seat.seatToken).toMatch(/^st_/)
    expect(minted.seat.discordUserId).toBe('u2')
    expect(minted.personalUrl).toContain(`seat=${minted.seat.seatToken}`)
    const [after] = await db.select().from(matches).where(eq(matches.id, m.id))
    expect(after!.status).toBe('active')
  })

  it('returns the same link on a second click, not a second seat', async () => {
    const db = await testDb()
    const m = await seedMatch(db)
    const first = await mintSeat(db, m, { id: 'u2', displayName: 'Alice' })
    const second = await mintSeat(db, m, { id: 'u2', displayName: 'Alice' })
    expect(second.reused).toBe(true)
    expect(second.seat.seatToken).toBe(first.seat.seatToken)
  })

  it('rejects when all human seats are taken (players - bots)', async () => {
    const db = await testDb()
    const m = await seedMatch(db) // 3 players, 1 bot → 2 human seats
    await mintSeat(db, m, { id: 'u2', displayName: 'Alice' })
    await mintSeat(db, m, { id: 'u3', displayName: 'Bob' })
    await expect(mintSeat(db, m, { id: 'u4', displayName: 'Cara' })).rejects.toThrow(MatchFullError)
  })

  it('rejects joins on a closed match', async () => {
    const db = await testDb()
    const m = await seedMatch(db, { status: 'expired' })
    await expect(mintSeat(db, m, { id: 'u2', displayName: 'Alice' })).rejects.toThrow(MatchClosedError)
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/seats.test.ts`
Expected: FAIL — `mintSeat` not exported.

- [x] **Step 3: Write the implementation (append to `src/matches.ts`)**

Add imports at the top of `src/matches.ts`: `import { and, eq } from 'drizzle-orm'` and extend the schema import to `import { matches, seats, type MatchRow, type SeatRow } from './db/schema.js'`. Then append:

```ts
export class MatchClosedError extends Error {}
export class MatchFullError extends Error {}

/** joinUrl + `&seat=<token>` — tokens are opaque to the game; it binds token → seat. */
export function personalJoinUrl(joinUrl: string, seatToken: string): string {
  const u = new URL(joinUrl)
  u.searchParams.set('seat', seatToken)
  return u.toString()
}

export interface MintedSeat {
  seat: SeatRow
  personalUrl: string
  reused: boolean
}

export async function mintSeat(
  db: Db,
  match: MatchRow,
  user: { id: string; displayName: string },
): Promise<MintedSeat> {
  if (match.status !== 'pending' && match.status !== 'active') throw new MatchClosedError('match is closed')
  const [existing] = await db
    .select()
    .from(seats)
    .where(and(eq(seats.matchId, match.id), eq(seats.discordUserId, user.id)))
  if (existing) return { seat: existing, personalUrl: personalJoinUrl(match.joinUrl, existing.seatToken), reused: true }
  const taken = await db.select().from(seats).where(eq(seats.matchId, match.id))
  if (taken.length >= match.players - match.bots) throw new MatchFullError('all seats are taken')
  const [seat] = await db
    .insert(seats)
    .values({
      matchId: match.id,
      seatToken: newToken('st'),
      discordUserId: user.id,
      displayName: user.displayName,
    })
    .returning()
  if (match.status === 'pending') await db.update(matches).set({ status: 'active' }).where(eq(matches.id, match.id))
  return { seat: seat!, personalUrl: personalJoinUrl(match.joinUrl, seat!.seatToken), reused: false }
}
```

- [x] **Step 4: Run tests and lint to verify they pass**

Run: `npx vitest run test/seats.test.ts test/matches.test.ts && npm run lint`
Expected: PASS, tsc clean.

- [x] **Step 5: Commit**

```bash
git add src/matches.ts test/seats.test.ts
git commit -m "feat: seat minting with reuse, capacity, and lifecycle activation"
```

---

### Task 6: Embeds and Join button components

**Files:**
- Create: `src/embeds.ts`
- Test: `test/embeds.test.ts`

**Interfaces:**
- Consumes: `GameDef` (Task 2), `MatchRow`/`SeatRow` (Task 1).
- Produces: `matchEmbed(game: GameDef, match: MatchRow): EmbedBuilder`; `joinRow(matchId: number): ActionRowBuilder<ButtonBuilder>` (button customId `join:<matchId>`); `resultEmbed(game: GameDef, match: MatchRow, seatRows: SeatRow[]): EmbedBuilder`.

- [x] **Step 1: Write the failing test**

```ts
// test/embeds.test.ts
import { describe, expect, it } from 'vitest'
import type { MatchRow, SeatRow } from '../src/db/schema.js'
import { joinRow, matchEmbed, resultEmbed } from '../src/embeds.js'
import { getGame } from '../src/games.js'

const MATCH: MatchRow = {
  id: 7, guildId: 'g1', channelId: 'c1', gameSlug: 'catan', code: 'ABCD',
  joinUrl: 'http://play.example/?join=ABCD', callbackToken: 'cb_x', status: 'completed',
  createdByDiscordId: 'u1', players: 4, bots: 1,
  createdAt: new Date('2026-08-27T10:00:00Z'), expiresAt: new Date('2026-08-27T12:00:00Z'), finishedAt: null,
}

function seat(over: Partial<SeatRow>): SeatRow {
  return {
    id: 1, matchId: 7, seatToken: 'st_x', discordUserId: null, displayName: null,
    placement: null, winner: null, stats: null, ...over,
  }
}

describe('matchEmbed / joinRow', () => {
  it('shows game, room code, seats, and expiry', () => {
    const flat = JSON.stringify(matchEmbed(getGame('catan')!, MATCH).toJSON())
    expect(flat).toContain('ABCD')
    expect(flat).toContain('CATAN')
    expect(flat).toContain('4 (1 bot)')
    expect(flat).toContain('<t:')
  })

  it('joinRow carries the match id in the customId', () => {
    const json = joinRow(7).toJSON()
    expect(JSON.stringify(json)).toContain('"custom_id":"join:7"')
  })
})

describe('resultEmbed', () => {
  it('orders by placement, crowns the winner, mentions bound users, renders stats compactly', () => {
    const rows = [
      seat({ id: 2, placement: 2, displayName: 'BotAlice' }),
      seat({ id: 1, seatToken: 'st_w', placement: 1, winner: true, discordUserId: 'u9', stats: { vp: 10, longestRoad: true } }),
    ]
    const flat = JSON.stringify(resultEmbed(getGame('catan')!, MATCH, rows).toJSON())
    expect(flat.indexOf('<@u9>')).toBeLessThan(flat.indexOf('BotAlice'))
    expect(flat).toContain('🏆')
    expect(flat).toContain('vp: 10')
    expect(flat).toContain('longestRoad')
  })

  it('labels abandoned matches and tolerates empty seats', () => {
    const flat = JSON.stringify(resultEmbed(getGame('catan')!, { ...MATCH, status: 'abandoned' }, []).toJSON())
    expect(flat).toContain('abandoned')
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/embeds.test.ts`
Expected: FAIL — cannot resolve `../src/embeds.js`.

- [x] **Step 3: Write the implementation**

```ts
// src/embeds.ts
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js'
import type { MatchRow, SeatRow } from './db/schema.js'
import type { GameDef } from './games.js'

export function matchEmbed(game: GameDef, match: MatchRow): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`${game.name} match ready`)
    .setDescription('Click **Join** below to get your personal seat link.')
    .addFields(
      { name: 'Room code', value: `\`${match.code}\``, inline: true },
      { name: 'Seats', value: `${match.players} (${match.bots} bot${match.bots === 1 ? '' : 's'})`, inline: true },
    )
    .setColor(0x2c6e8f)
  if (match.expiresAt) {
    const expires = Math.floor(match.expiresAt.getTime() / 1000)
    embed.addFields({ name: 'Link expires', value: `<t:${expires}:R> if nobody joins`, inline: true })
  }
  return embed
}

export function joinRow(matchId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`join:${matchId}`).setLabel('Join').setStyle(ButtonStyle.Primary),
  )
}

/** Free-form per-game extras blob, rendered compactly and never aggregated. */
function statsLine(stats: unknown): string {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return ''
  const parts = Object.entries(stats as Record<string, unknown>).map(([k, v]) => (v === true ? k : `${k}: ${String(v)}`))
  return parts.length ? ` — ${parts.join(' · ')}` : ''
}

export function resultEmbed(game: GameDef, match: MatchRow, seatRows: SeatRow[]): EmbedBuilder {
  const ordered = [...seatRows].sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99))
  const lines = ordered.map((s) => {
    const name = s.discordUserId ? `<@${s.discordUserId}>` : (s.displayName ?? 'Anonymous')
    const place = s.placement != null ? `${s.placement}. ` : ''
    return `${place}${s.winner ? '🏆 ' : ''}${name}${statsLine(s.stats)}`
  })
  const completed = match.status === 'completed'
  return new EmbedBuilder()
    .setTitle(`${game.name} — match ${completed ? 'complete' : 'abandoned'}`)
    .setDescription(lines.join('\n') || 'No seat results reported.')
    .addFields({ name: 'Room code', value: `\`${match.code}\``, inline: true })
    .setColor(completed ? 0x3f9e58 : 0x8f6e2c)
}
```

- [x] **Step 4: Run tests and lint to verify they pass**

Run: `npx vitest run test/embeds.test.ts && npm run lint`
Expected: PASS, tsc clean.

- [x] **Step 5: Commit**

```bash
git add src/embeds.ts test/embeds.test.ts
git commit -m "feat: match and result embeds with Join button row"
```

---

### Task 7: `/play`, `/games`, and `/catan` as alias

**Files:**
- Create: `src/commands/play.ts`, `src/commands/games.ts`
- Modify: `src/commands/index.ts`, `src/commands/catan.ts`
- Delete: `src/meridian.ts`, `test/meridian.test.ts`, `test/catan-command.test.ts` (superseded)
- Test: `test/play-command.test.ts`

**Interfaces:**
- Consumes: registry (Task 2), `GameLaunchError` (Task 3), `launchMatch` (Task 4), `matchEmbed`/`joinRow` (Task 6), `getDb` (Task 1), `gameRoles` table.
- Produces: `interface Command { data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody }; execute(i: ChatInputCommandInteraction): Promise<void>; autocomplete?(i: AutocompleteInteraction): Promise<void> }`; `interface PlayDeps { db: Db; launch: typeof launchMatch; publicBaseUrl: string }`; `defaultPlayDeps(): PlayDeps`; `runPlay(interaction, slug: string, deps: PlayDeps): Promise<void>`; `playCommand`, `catanCommand`, `gamesCommand`.

- [ ] **Step 1: Write the failing test**

```ts
// test/play-command.test.ts
import { describe, expect, it, vi } from 'vitest'
import { matches } from '../src/db/schema.js'
import { catanCommand } from '../src/commands/catan.js'
import { playCommand, type PlayDeps } from '../src/commands/play.js'
import { launchMatch } from '../src/matches.js'
import { testDb } from './helpers/db.js'

const LAUNCHED = { code: 'ABCD', joinUrl: 'http://play.example/?join=ABCD', expiresAt: '2026-08-27T12:00:00.000Z' }

interface FakeInteraction {
  options: {
    getString: (name: string, required?: boolean) => string | null
    getInteger: (name: string) => number | null
  }
  guildId: string | null
  channelId: string
  user: { id: string; displayName: string }
  deferReply: ReturnType<typeof vi.fn>
  editReply: ReturnType<typeof vi.fn>
  reply: ReturnType<typeof vi.fn>
}

function fakeInteraction(opts: { game?: string; players?: number; bots?: number; guildId?: string | null } = {}): FakeInteraction {
  return {
    options: {
      getString: () => opts.game ?? null,
      getInteger: (name) => (name === 'players' ? (opts.players ?? null) : (opts.bots ?? null)),
    },
    guildId: opts.guildId === undefined ? 'g1' : opts.guildId,
    channelId: 'c1',
    user: { id: 'u1', displayName: 'Ayo' },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  }
}

function deps(db: Awaited<ReturnType<typeof testDb>>): PlayDeps {
  return {
    db,
    launch: (args) => launchMatch({ ...args, createMatch: vi.fn(async () => LAUNCHED) }),
    publicBaseUrl: 'http://steward.example',
  }
}

describe('/play', () => {
  it('launches, persists the match, and posts embed + Join button', async () => {
    const db = await testDb()
    const i = fakeInteraction({ game: 'catan', players: 4, bots: 1 })
    await playCommand.execute(i as never, deps(db))
    const rows = await db.select().from(matches)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.guildId).toBe('g1')
    const reply = JSON.stringify(i.editReply.mock.calls[0]![0])
    expect(reply).toContain('ABCD')
    expect(reply).toContain(`join:${rows[0]!.id}`)
  })

  it('rejects out-of-bounds players ephemerally without calling the game', async () => {
    const db = await testDb()
    const i = fakeInteraction({ game: 'catan', players: 9 })
    await playCommand.execute(i as never, deps(db))
    expect(i.deferReply).not.toHaveBeenCalled()
    expect(JSON.stringify(i.reply.mock.calls[0]![0])).toContain('players must be 3..8')
    expect(await db.select().from(matches)).toHaveLength(0)
  })

  it('rejects unknown games and DMs (no guild)', async () => {
    const db = await testDb()
    const bad = fakeInteraction({ game: 'chess' })
    await playCommand.execute(bad as never, deps(db))
    expect(JSON.stringify(bad.reply.mock.calls[0]![0])).toContain('Unknown game')
    const dm = fakeInteraction({ game: 'catan', guildId: null })
    await playCommand.execute(dm as never, deps(db))
    expect(JSON.stringify(dm.reply.mock.calls[0]![0])).toContain('server channel')
  })

  it('autocompletes games by name fragment', async () => {
    const respond = vi.fn(async () => undefined)
    await playCommand.autocomplete({ options: { getFocused: () => 'cat' }, respond } as never)
    expect(respond).toHaveBeenCalledWith([{ name: 'CATAN (Meridian)', value: 'catan' }])
  })
})

describe('/catan alias', () => {
  it('uses the same launch path with the catan slug', async () => {
    const db = await testDb()
    const i = fakeInteraction({ players: 3 })
    await catanCommand.execute(i as never, deps(db))
    const rows = await db.select().from(matches)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.gameSlug).toBe('catan')
    expect(rows[0]!.players).toBe(3)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/play-command.test.ts`
Expected: FAIL — cannot resolve `../src/commands/play.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/commands/play.ts
import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { getDb, type Db } from '../db/index.js'
import { joinRow, matchEmbed } from '../embeds.js'
import { GameLaunchError } from '../game-client.js'
import { games, getGame, validateLaunch } from '../games.js'
import { launchMatch } from '../matches.js'

export interface PlayDeps {
  db: Db
  launch: typeof launchMatch
  publicBaseUrl: string
}

export function defaultPlayDeps(): PlayDeps {
  return {
    db: getDb(),
    launch: launchMatch,
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787',
  }
}

/** Shared launch path for /play and per-game aliases like /catan. */
export async function runPlay(
  interaction: ChatInputCommandInteraction,
  slug: string,
  deps: PlayDeps,
): Promise<void> {
  const game = getGame(slug)
  if (!game) {
    await interaction.reply({ content: `Unknown game \`${slug}\` — see /games.`, flags: MessageFlags.Ephemeral })
    return
  }
  if (!interaction.guildId) {
    await interaction.reply({ content: 'This command only works in a server channel.', flags: MessageFlags.Ephemeral })
    return
  }
  const players = interaction.options.getInteger('players') ?? game.defaultPlayers
  const bots = interaction.options.getInteger('bots') ?? 0
  const invalid = validateLaunch(game, players, bots)
  if (invalid) {
    await interaction.reply({ content: `Could not launch: ${invalid}`, flags: MessageFlags.Ephemeral })
    return
  }
  await interaction.deferReply()
  try {
    const match = await deps.launch({
      db: deps.db,
      game,
      players,
      bots,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      createdByDiscordId: interaction.user.id,
      publicBaseUrl: deps.publicBaseUrl,
    })
    await interaction.editReply({ embeds: [matchEmbed(game, match)], components: [joinRow(match.id)] })
  } catch (e) {
    const reason = e instanceof GameLaunchError ? e.message : 'unexpected launch failure'
    await interaction.editReply({ content: `Could not launch the match: ${reason}` })
  }
}

export const playCommand = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Launch a game from the library')
    .addStringOption((o) => o.setName('game').setDescription('Which game').setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName('players').setDescription('Number of seats (per-game bounds)'))
    .addIntegerOption((o) => o.setName('bots').setDescription('Bot seats (default 0)')),

  async execute(interaction: ChatInputCommandInteraction, deps: PlayDeps = defaultPlayDeps()): Promise<void> {
    await runPlay(interaction, interaction.options.getString('game', true), deps)
  },

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const q = String(interaction.options.getFocused()).toLowerCase()
    await interaction.respond(
      games
        .filter((g) => g.slug.includes(q) || g.name.toLowerCase().includes(q))
        .slice(0, 25)
        .map((g) => ({ name: g.name, value: g.slug })),
    )
  },
}
```

Rewrite `src/commands/catan.ts` entirely:

```ts
// src/commands/catan.ts
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { defaultPlayDeps, runPlay, type PlayDeps } from './play.js'

/** Alias for `/play game:catan` — kept for muscle memory. */
export const catanCommand = {
  data: new SlashCommandBuilder()
    .setName('catan')
    .setDescription('Launch a CATAN (Meridian) match')
    .addIntegerOption((o) => o.setName('players').setDescription('Seats, 3-8 (default 4)').setMinValue(3).setMaxValue(8))
    .addIntegerOption((o) => o.setName('bots').setDescription('Bot seats, 0 to players-1 (default 0)').setMinValue(0).setMaxValue(7)),

  async execute(interaction: ChatInputCommandInteraction, deps: PlayDeps = defaultPlayDeps()): Promise<void> {
    await runPlay(interaction, 'catan', deps)
  },
}
```

```ts
// src/commands/games.ts
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { eq } from 'drizzle-orm'
import { getDb, type Db } from '../db/index.js'
import { gameRoles } from '../db/schema.js'
import { games } from '../games.js'

export interface GamesDeps {
  db: Db
}

export const gamesCommand = {
  data: new SlashCommandBuilder().setName('games').setDescription('List the game library'),

  async execute(interaction: ChatInputCommandInteraction, deps: GamesDeps = { db: getDb() }): Promise<void> {
    const roleRows = interaction.guildId
      ? await deps.db.select().from(gameRoles).where(eq(gameRoles.guildId, interaction.guildId))
      : []
    const lines = games.map((g) => {
      const role = roleRows.find((r) => r.gameSlug === g.slug)
      return `**${g.name}** (\`${g.slug}\`) — ${g.minPlayers}–${g.maxPlayers} players${role ? ` — <@&${role.roleId}>` : ''}`
    })
    await interaction.reply({ content: `**Game library**\n${lines.join('\n')}` })
  },
}
```

Rewrite `src/commands/index.ts`:

```ts
// src/commands/index.ts
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js'
import { catanCommand } from './catan.js'
import { gamesCommand } from './games.js'
import { playCommand } from './play.js'

export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody }
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>
}

/** All slash commands, keyed by name. New commands register here. */
export const commands: ReadonlyMap<string, Command> = new Map<string, Command>(
  [playCommand, catanCommand, gamesCommand].map((c) => [c.data.name, c] as const),
)
```

Delete the superseded v0 files:

```bash
git rm src/meridian.ts test/meridian.test.ts test/catan-command.test.ts
```

- [ ] **Step 4: Run the full suite and lint**

Run: `npm test && npm run lint`
Expected: all PASS (deploy-commands still compiles — it only calls `data.toJSON()`).

- [ ] **Step 5: Commit**

```bash
git add -A src test
git commit -m "feat: /play generic launcher with autocomplete, /games, /catan as alias"
```

---

### Task 8: Join button handler

**Files:**
- Create: `src/interactions/join.ts`
- Test: `test/join-button.test.ts`

**Interfaces:**
- Consumes: `mintSeat`, `MatchClosedError`, `MatchFullError` (Task 5); `getDb` (Task 1).
- Produces: `isJoinButton(customId: string): boolean`; `handleJoinButton(interaction: ButtonInteraction, db?: Db): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/join-button.test.ts
import { describe, expect, it, vi } from 'vitest'
import { matches, seats } from '../src/db/schema.js'
import { handleJoinButton, isJoinButton } from '../src/interactions/join.js'
import { testDb } from './helpers/db.js'

async function seed(db: Awaited<ReturnType<typeof testDb>>, status = 'pending' as const) {
  const [m] = await db
    .insert(matches)
    .values({
      guildId: 'g1', channelId: 'c1', gameSlug: 'catan', code: 'ABCD',
      joinUrl: 'http://play.example/?join=ABCD', callbackToken: 'cb_x',
      createdByDiscordId: 'u1', players: 4, bots: 0, status,
    })
    .returning()
  return m!
}

function fakeButton(customId: string) {
  return {
    customId,
    user: { id: 'u2', displayName: 'Alice' },
    reply: vi.fn(async () => undefined),
  }
}

describe('join button', () => {
  it('recognizes only join customIds', () => {
    expect(isJoinButton('join:7')).toBe(true)
    expect(isJoinButton('roles:pick')).toBe(false)
  })

  it('replies ephemerally with a personal seat link', async () => {
    const db = await testDb()
    const m = await seed(db)
    const i = fakeButton(`join:${m.id}`)
    await handleJoinButton(i as never, db)
    const reply = i.reply.mock.calls[0]![0] as { content: string; flags: number }
    expect(reply.content).toContain('seat=st_')
    expect(reply.flags).toBeTruthy()
    expect(await db.select().from(seats)).toHaveLength(1)
  })

  it('tells the user when the match is closed', async () => {
    const db = await testDb()
    const m = await seed(db, 'expired' as never)
    const i = fakeButton(`join:${m.id}`)
    await handleJoinButton(i as never, db)
    expect((i.reply.mock.calls[0]![0] as { content: string }).content).toContain('closed')
  })

  it('handles a vanished match without throwing', async () => {
    const db = await testDb()
    const i = fakeButton('join:999')
    await handleJoinButton(i as never, db)
    expect((i.reply.mock.calls[0]![0] as { content: string }).content).toContain('no longer exists')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/join-button.test.ts`
Expected: FAIL — cannot resolve `../src/interactions/join.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/interactions/join.ts
import { MessageFlags, type ButtonInteraction } from 'discord.js'
import { eq } from 'drizzle-orm'
import { getDb, type Db } from '../db/index.js'
import { matches } from '../db/schema.js'
import { MatchClosedError, MatchFullError, mintSeat } from '../matches.js'

export function isJoinButton(customId: string): boolean {
  return customId.startsWith('join:')
}

export async function handleJoinButton(interaction: ButtonInteraction, db: Db = getDb()): Promise<void> {
  const matchId = Number(interaction.customId.slice('join:'.length))
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId))
  if (!match) {
    await interaction.reply({ content: 'This match no longer exists.', flags: MessageFlags.Ephemeral })
    return
  }
  try {
    const minted = await mintSeat(db, match, { id: interaction.user.id, displayName: interaction.user.displayName })
    const lead = minted.reused ? 'Your seat link (already claimed):' : 'Your personal seat link:'
    await interaction.reply({ content: `${lead}\n${minted.personalUrl}`, flags: MessageFlags.Ephemeral })
  } catch (e) {
    const content =
      e instanceof MatchClosedError
        ? 'This match is closed.'
        : e instanceof MatchFullError
          ? 'All seats are taken.'
          : 'Could not mint your seat link.'
    await interaction.reply({ content, flags: MessageFlags.Ephemeral })
  }
}
```

- [ ] **Step 4: Run tests and lint to verify they pass**

Run: `npx vitest run test/join-button.test.ts && npm run lint`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/interactions/join.ts test/join-button.test.ts
git commit -m "feat: Join button mints ephemeral personal seat links"
```

---

### Task 9: Result processing (idempotent webhook core)

**Files:**
- Create: `src/results.ts`
- Test: `test/results.test.ts`

**Interfaces:**
- Consumes: `Db`, `matches`, `seats`, `MatchRow`, `SeatRow` (Task 1); `newToken` (Task 4).
- Produces: `resultSchema` (zod); `type ResultReport = z.infer<typeof resultSchema>`; `type ProcessOutcome = { kind: 'ok'; match: MatchRow; seats: SeatRow[] } | { kind: 'duplicate' } | { kind: 'unknown' } | { kind: 'unauthorized' }`; `processResult(db: Db, bearerToken: string, report: ResultReport): Promise<ProcessOutcome>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/results.test.ts
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db } from '../src/db/index.js'
import { matches, seats } from '../src/db/schema.js'
import { processResult, resultSchema } from '../src/results.js'
import { testDb } from './helpers/db.js'

async function seed(db: Db, status: 'pending' | 'active' | 'expired' = 'active') {
  const [m] = await db
    .insert(matches)
    .values({
      guildId: 'g1', channelId: 'c1', gameSlug: 'catan', code: 'ABCD',
      joinUrl: 'http://play.example/?join=ABCD', callbackToken: 'cb_good',
      createdByDiscordId: 'u1', players: 3, bots: 1, status,
    })
    .returning()
  await db.insert(seats).values([
    { matchId: m!.id, seatToken: 'st_alice', discordUserId: 'u2', displayName: 'Alice' },
    { matchId: m!.id, seatToken: 'st_bob', discordUserId: 'u3', displayName: 'Bob' },
  ])
  return m!
}

const REPORT = resultSchema.parse({
  code: 'ABCD',
  status: 'completed',
  seats: [
    { seatToken: 'st_alice', displayName: 'Alice', placement: 1, winner: true, stats: { vp: 10, longestRoad: true } },
    { seatToken: 'st_bob', displayName: 'Bob', placement: 2, winner: false, stats: { vp: 7 } },
    { displayName: 'RandoBot', placement: 3, winner: false },
  ],
})

describe('processResult', () => {
  it('completes the match, upserts tokened seats, inserts anonymous seats', async () => {
    const db = await testDb()
    const m = await seed(db)
    const out = await processResult(db, 'cb_good', REPORT)
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.match.status).toBe('completed')
    expect(out.match.finishedAt).not.toBeNull()
    expect(out.seats).toHaveLength(3)
    const alice = out.seats.find((s) => s.seatToken === 'st_alice')!
    expect(alice.winner).toBe(true)
    expect(alice.discordUserId).toBe('u2')
    expect(alice.stats).toEqual({ vp: 10, longestRoad: true })
    const anon = out.seats.find((s) => s.displayName === 'RandoBot')!
    expect(anon.discordUserId).toBeNull()
  })

  it('is idempotent: a second delivery is a duplicate no-op', async () => {
    const db = await testDb()
    await seed(db)
    await processResult(db, 'cb_good', REPORT)
    const again = await processResult(db, 'cb_good', REPORT)
    expect(again.kind).toBe('duplicate')
    expect(await db.select().from(seats)).toHaveLength(3) // no re-inserted anon seats
  })

  it('a late completed webhook wins over the sweep\'s expired guess', async () => {
    const db = await testDb()
    const m = await seed(db, 'expired')
    const out = await processResult(db, 'cb_good', REPORT)
    expect(out.kind).toBe('ok')
    const [after] = await db.select().from(matches).where(eq(matches.id, m.id))
    expect(after!.status).toBe('completed')
  })

  it('rejects unknown codes and bad tokens distinctly', async () => {
    const db = await testDb()
    await seed(db)
    expect((await processResult(db, 'cb_good', { ...REPORT, code: 'ZZZZ' })).kind).toBe('unknown')
    expect((await processResult(db, 'cb_evil', REPORT)).kind).toBe('unauthorized')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/results.test.ts`
Expected: FAIL — cannot resolve `../src/results.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/results.ts
import { and, eq, notInArray } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from './db/index.js'
import { matches, seats, type MatchRow, type SeatRow } from './db/schema.js'
import { newToken } from './tokens.js'

export const resultSchema = z.object({
  code: z.string().min(1),
  status: z.enum(['completed', 'abandoned']),
  seats: z.array(
    z.object({
      seatToken: z.string().optional(),
      displayName: z.string().optional(),
      placement: z.number().int().positive().optional(),
      winner: z.boolean().optional(),
      stats: z.record(z.unknown()).optional(),
    }),
  ),
})

export type ResultReport = z.infer<typeof resultSchema>

export type ProcessOutcome =
  | { kind: 'ok'; match: MatchRow; seats: SeatRow[] }
  | { kind: 'duplicate' }
  | { kind: 'unknown' }
  | { kind: 'unauthorized' }

export async function processResult(db: Db, bearerToken: string, report: ResultReport): Promise<ProcessOutcome> {
  const candidates = await db.select().from(matches).where(eq(matches.code, report.code))
  if (candidates.length === 0) return { kind: 'unknown' }
  const match = candidates.find((m) => m.callbackToken === bearerToken)
  if (!match) return { kind: 'unauthorized' }

  // First transition to a final status wins; guarded update makes replays no-ops.
  // A late `completed` still wins over `expired` — the game is the source of truth.
  const [finalized] = await db
    .update(matches)
    .set({ status: report.status, finishedAt: new Date() })
    .where(and(eq(matches.id, match.id), notInArray(matches.status, ['completed', 'abandoned'])))
    .returning()
  if (!finalized) return { kind: 'duplicate' }

  for (const s of report.seats) {
    if (s.seatToken) {
      const updated = await db
        .update(seats)
        .set({
          ...(s.displayName !== undefined ? { displayName: s.displayName } : {}),
          placement: s.placement ?? null,
          winner: s.winner ?? false,
          stats: s.stats ?? null,
        })
        .where(and(eq(seats.matchId, match.id), eq(seats.seatToken, s.seatToken)))
        .returning()
      if (updated.length > 0) continue
      // A token Steward never minted for this match: store the seat, but anonymously.
    }
    await db.insert(seats).values({
      matchId: match.id,
      seatToken: newToken('st'),
      discordUserId: null,
      displayName: s.displayName ?? null,
      placement: s.placement ?? null,
      winner: s.winner ?? false,
      stats: s.stats ?? null,
    })
  }

  const allSeats = await db.select().from(seats).where(eq(seats.matchId, match.id))
  return { kind: 'ok', match: finalized, seats: allSeats }
}
```

- [ ] **Step 4: Run tests and lint to verify they pass**

Run: `npx vitest run test/results.test.ts && npm run lint`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/results.ts test/results.test.ts
git commit -m "feat: idempotent result processing with anonymous-seat support"
```

---

### Task 10: Webhook HTTP server

**Files:**
- Create: `src/webhook-server.ts`
- Test: `test/webhook-server.test.ts`

**Interfaces:**
- Consumes: `processResult`, `resultSchema` (Task 9); `Db`, `MatchRow`, `SeatRow` (Task 1).
- Produces: `interface WebhookDeps { db: Db; onResult: (match: MatchRow, seats: SeatRow[]) => Promise<void> }`; `createWebhookServer(deps: WebhookDeps): http.Server`.

- [ ] **Step 1: Write the failing test**

```ts
// test/webhook-server.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { matches, seats } from '../src/db/schema.js'
import { createWebhookServer } from '../src/webhook-server.js'
import { testDb } from './helpers/db.js'

let server: http.Server | undefined
afterEach(() => server?.close())

async function setup() {
  const db = await testDb()
  const [m] = await db
    .insert(matches)
    .values({
      guildId: 'g1', channelId: 'c1', gameSlug: 'catan', code: 'ABCD',
      joinUrl: 'http://play.example/?join=ABCD', callbackToken: 'cb_good',
      createdByDiscordId: 'u1', players: 3, bots: 0, status: 'active',
    })
    .returning()
  await db.insert(seats).values({ matchId: m!.id, seatToken: 'st_alice', discordUserId: 'u2', displayName: 'Alice' })
  const onResult = vi.fn(async () => undefined)
  server = createWebhookServer({ db, onResult })
  await new Promise<void>((r) => server!.listen(0, r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { db, onResult, base }
}

function post(base: string, token: string | null, body: string) {
  return fetch(`${base}/webhooks/results`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
  })
}

const GOOD = JSON.stringify({
  code: 'ABCD',
  status: 'completed',
  seats: [{ seatToken: 'st_alice', placement: 1, winner: true, stats: { vp: 10 } }],
})

describe('webhook server', () => {
  it('persists, returns 200, then fires onResult best-effort', async () => {
    const { onResult, base } = await setup()
    const res = await post(base, 'cb_good', GOOD)
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1))
    const [match, seatRows] = onResult.mock.calls[0] as never[]
    expect((match as { status: string }).status).toBe('completed')
    expect(seatRows).toHaveLength(1)
  })

  it('maps unknown code to 404 and bad token to 401', async () => {
    const { base } = await setup()
    expect((await post(base, 'cb_good', GOOD.replace('ABCD', 'ZZZZ'))).status).toBe(404)
    expect((await post(base, 'cb_evil', GOOD)).status).toBe(401)
    expect((await post(base, null, GOOD)).status).toBe(401)
  })

  it('rejects malformed bodies with 422 and unknown routes with 404', async () => {
    const { base } = await setup()
    expect((await post(base, 'cb_good', 'not json{')).status).toBe(422)
    expect((await post(base, 'cb_good', JSON.stringify({ code: 'ABCD' }))).status).toBe(422)
    expect((await fetch(`${base}/nope`)).status).toBe(404)
  })

  it('answers duplicates with 200 without re-firing onResult', async () => {
    const { onResult, base } = await setup()
    await post(base, 'cb_good', GOOD)
    const res = await post(base, 'cb_good', GOOD)
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/webhook-server.test.ts`
Expected: FAIL — cannot resolve `../src/webhook-server.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/webhook-server.ts
import http from 'node:http'
import type { Db } from './db/index.js'
import type { MatchRow, SeatRow } from './db/schema.js'
import { processResult, resultSchema } from './results.js'

export interface WebhookDeps {
  db: Db
  /** Best-effort embed posting — runs after the 2xx; a Discord outage never makes the game retry. */
  onResult: (match: MatchRow, seats: SeatRow[]) => Promise<void>
}

export function createWebhookServer(deps: WebhookDeps): http.Server {
  return http.createServer((req, res) => {
    handle(req, res, deps).catch((e) => {
      console.error('[webhook] handler crashed:', e)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal error' }))
      }
    })
  })
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: WebhookDeps): Promise<void> {
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'POST' || req.url !== '/webhooks/results') return send(404, { error: 'not found' })
  const auth = req.headers.authorization ?? ''
  if (!auth.startsWith('Bearer ')) return send(401, { error: 'missing bearer token' })
  const token = auth.slice('Bearer '.length)

  let raw: string
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    raw = Buffer.concat(chunks).toString('utf8')
  } catch {
    return send(422, { error: 'unreadable body' })
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return send(422, { error: 'malformed JSON' })
  }
  const parsed = resultSchema.safeParse(json)
  if (!parsed.success) return send(422, { error: 'invalid result payload' })

  const outcome = await processResult(deps.db, token, parsed.data)
  switch (outcome.kind) {
    case 'unknown':
      return send(404, { error: 'unknown match code' })
    case 'unauthorized':
      return send(401, { error: 'bad callback token' })
    case 'duplicate':
      return send(200, { ok: true, duplicate: true })
    case 'ok':
      send(200, { ok: true })
      deps.onResult(outcome.match, outcome.seats).catch((e) => console.error('[webhook] result posting failed:', e))
  }
}
```

- [ ] **Step 4: Run tests and lint to verify they pass**

Run: `npx vitest run test/webhook-server.test.ts && npm run lint`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/webhook-server.ts test/webhook-server.test.ts
git commit -m "feat: result webhook server (persist, 2xx, best-effort posting)"
```

---

### Task 11: Stats aggregations + `/stats` + `/leaderboard`

**Files:**
- Create: `src/stats.ts`, `src/commands/stats.ts`, `src/commands/leaderboard.ts`
- Modify: `src/commands/index.ts` (register both)
- Test: `test/stats.test.ts`

**Interfaces:**
- Consumes: `Db`, `matches`, `seats` (Task 1); registry + `playCommand.autocomplete` pattern (Task 7).
- Produces: `interface GameStats { gameSlug: string; games: number; wins: number; winRate: number }`; `playerStats(db: Db, guildId: string, discordUserId: string, gameSlug?: string): Promise<GameStats[]>`; `interface LeaderRow { discordUserId: string; games: number; wins: number; winRate: number }`; `leaderboard(db: Db, guildId: string, gameSlug: string, limit?: number): Promise<LeaderRow[]>`; `statsCommand`, `leaderboardCommand` (both take optional `{ db }` deps like `gamesCommand`).

- [ ] **Step 1: Write the failing test**

```ts
// test/stats.test.ts
import { describe, expect, it } from 'vitest'
import type { Db } from '../src/db/index.js'
import { matches, seats } from '../src/db/schema.js'
import { leaderboard, playerStats } from '../src/stats.js'
import { testDb } from './helpers/db.js'

let nextCode = 0
async function finishedMatch(
  db: Db,
  guildId: string,
  results: Array<{ user: string | null; winner: boolean }>,
  status: 'completed' | 'abandoned' = 'completed',
  gameSlug = 'catan',
) {
  const code = `M${nextCode++}`
  const [m] = await db
    .insert(matches)
    .values({
      guildId, channelId: 'c1', gameSlug, code, joinUrl: `http://p.example/?join=${code}`,
      callbackToken: `cb_${code}`, createdByDiscordId: 'u0',
      players: results.length, bots: 0, status, finishedAt: new Date(),
    })
    .returning()
  await db.insert(seats).values(
    results.map((r, i) => ({
      matchId: m!.id, seatToken: `st_${code}_${i}`, discordUserId: r.user,
      displayName: r.user ?? 'Anon', placement: i + 1, winner: r.winner,
    })),
  )
}

describe('playerStats', () => {
  it('computes games, wins, and win rate per game, excluding abandoned matches', async () => {
    const db = await testDb()
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: true }, { user: 'u2', winner: false }])
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: false }, { user: 'u2', winner: true }])
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: false }, { user: 'u2', winner: true }])
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: true }], 'abandoned')
    const rows = await playerStats(db, 'g1', 'u1')
    expect(rows).toEqual([{ gameSlug: 'catan', games: 3, wins: 1, winRate: 1 / 3 }])
  })

  it('scopes to the guild', async () => {
    const db = await testDb()
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: true }])
    await finishedMatch(db, 'g2', [{ user: 'u1', winner: true }])
    const rows = await playerStats(db, 'g1', 'u1')
    expect(rows[0]!.games).toBe(1)
  })
})

describe('leaderboard', () => {
  it('ranks by wins then win rate and skips anonymous seats', async () => {
    const db = await testDb()
    // u1: 2 wins / 4 games (50%); u2: 2 wins / 2 games (100%) → tiebreak on rate; u3: 0 wins; one anonymous seat
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: true }, { user: null, winner: false }])
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: true }, { user: 'u3', winner: false }])
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: false }, { user: 'u2', winner: true }])
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: false }, { user: 'u2', winner: true }])
    const rows = await leaderboard(db, 'g1', 'catan')
    expect(rows.map((r) => r.discordUserId)).toEqual(['u2', 'u1', 'u3'])
    expect(rows[0]).toEqual({ discordUserId: 'u2', games: 2, wins: 2, winRate: 1 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/stats.test.ts`
Expected: FAIL — cannot resolve `../src/stats.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/stats.ts
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { matches, seats } from './db/schema.js'

export interface GameStats {
  gameSlug: string
  games: number
  wins: number
  winRate: number
}

export interface LeaderRow {
  discordUserId: string
  games: number
  wins: number
  winRate: number
}

const gamesExpr = sql<number>`count(*)`.mapWith(Number)
const winsExpr = sql<number>`count(*) filter (where ${seats.winner})`.mapWith(Number)

/** Derived on the fly from seats ⋈ matches; only completed matches count. */
export async function playerStats(db: Db, guildId: string, discordUserId: string, gameSlug?: string): Promise<GameStats[]> {
  const filters = [
    eq(matches.guildId, guildId),
    eq(matches.status, 'completed'),
    eq(seats.discordUserId, discordUserId),
  ]
  if (gameSlug) filters.push(eq(matches.gameSlug, gameSlug))
  const rows = await db
    .select({ gameSlug: matches.gameSlug, games: gamesExpr, wins: winsExpr })
    .from(seats)
    .innerJoin(matches, eq(seats.matchId, matches.id))
    .where(and(...filters))
    .groupBy(matches.gameSlug)
  return rows.map((r) => ({ ...r, winRate: r.games > 0 ? r.wins / r.games : 0 }))
}

export async function leaderboard(db: Db, guildId: string, gameSlug: string, limit = 10): Promise<LeaderRow[]> {
  const winRateExpr = sql`(count(*) filter (where ${seats.winner}))::float / count(*)`
  const rows = await db
    .select({ discordUserId: seats.discordUserId, games: gamesExpr, wins: winsExpr })
    .from(seats)
    .innerJoin(matches, eq(seats.matchId, matches.id))
    .where(
      and(
        eq(matches.guildId, guildId),
        eq(matches.status, 'completed'),
        eq(matches.gameSlug, gameSlug),
        isNotNull(seats.discordUserId),
      ),
    )
    .groupBy(seats.discordUserId)
    .orderBy(desc(winsExpr), desc(winRateExpr))
    .limit(limit)
  return rows.map((r) => ({
    discordUserId: r.discordUserId!,
    games: r.games,
    wins: r.wins,
    winRate: r.games > 0 ? r.wins / r.games : 0,
  }))
}
```

```ts
// src/commands/stats.ts
import { EmbedBuilder, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js'
import { getDb, type Db } from '../db/index.js'
import { games, getGame } from '../games.js'
import { playerStats } from '../stats.js'

export interface StatsDeps {
  db: Db
}

const pct = (r: number): string => `${Math.round(r * 100)}%`

export const statsCommand = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Game stats for a player in this server')
    .addUserOption((o) => o.setName('user').setDescription('Whose stats (default: you)'))
    .addStringOption((o) => o.setName('game').setDescription('Limit to one game').setAutocomplete(true)),

  async execute(interaction: ChatInputCommandInteraction, deps: StatsDeps = { db: getDb() }): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Stats are per-server — use this in a server channel.' })
      return
    }
    const target = interaction.options.getUser('user') ?? interaction.user
    const slug = interaction.options.getString('game') ?? undefined
    const rows = await playerStats(deps.db, interaction.guildId, target.id, slug)
    if (rows.length === 0) {
      await interaction.reply({ content: `No completed games for <@${target.id}> yet.` })
      return
    }
    const lines = rows.map((r) => {
      const name = getGame(r.gameSlug)?.name ?? r.gameSlug
      return `**${name}** — ${r.games} game${r.games === 1 ? '' : 's'} · ${r.wins} win${r.wins === 1 ? '' : 's'} · ${pct(r.winRate)}`
    })
    const embed = new EmbedBuilder().setTitle(`Stats — ${target.displayName}`).setDescription(lines.join('\n')).setColor(0x2c6e8f)
    await interaction.reply({ embeds: [embed] })
  },

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const q = String(interaction.options.getFocused()).toLowerCase()
    await interaction.respond(
      games.filter((g) => g.slug.includes(q) || g.name.toLowerCase().includes(q)).slice(0, 25).map((g) => ({ name: g.name, value: g.slug })),
    )
  },
}
```

```ts
// src/commands/leaderboard.ts
import { EmbedBuilder, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js'
import { getDb, type Db } from '../db/index.js'
import { games, getGame } from '../games.js'
import { leaderboard } from '../stats.js'

export interface LeaderboardDeps {
  db: Db
}

export const leaderboardCommand = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top players for a game in this server')
    .addStringOption((o) => o.setName('game').setDescription('Which game').setRequired(true).setAutocomplete(true)),

  async execute(interaction: ChatInputCommandInteraction, deps: LeaderboardDeps = { db: getDb() }): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Leaderboards are per-server — use this in a server channel.' })
      return
    }
    const slug = interaction.options.getString('game', true)
    const game = getGame(slug)
    if (!game) {
      await interaction.reply({ content: `Unknown game \`${slug}\` — see /games.` })
      return
    }
    const rows = await leaderboard(deps.db, interaction.guildId, slug)
    if (rows.length === 0) {
      await interaction.reply({ content: `No completed ${game.name} games yet.` })
      return
    }
    const lines = rows.map(
      (r, i) => `${i + 1}. <@${r.discordUserId}> — ${r.wins} win${r.wins === 1 ? '' : 's'} / ${r.games} (${Math.round(r.winRate * 100)}%)`,
    )
    const embed = new EmbedBuilder().setTitle(`${game.name} — leaderboard`).setDescription(lines.join('\n')).setColor(0x2c6e8f)
    await interaction.reply({ embeds: [embed] })
  },

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const q = String(interaction.options.getFocused()).toLowerCase()
    await interaction.respond(
      games.filter((g) => g.slug.includes(q) || g.name.toLowerCase().includes(q)).slice(0, 25).map((g) => ({ name: g.name, value: g.slug })),
    )
  },
}
```

Register in `src/commands/index.ts` (extend the array):

```ts
import { leaderboardCommand } from './leaderboard.js'
import { statsCommand } from './stats.js'
// ...
export const commands: ReadonlyMap<string, Command> = new Map<string, Command>(
  [playCommand, catanCommand, gamesCommand, statsCommand, leaderboardCommand].map((c) => [c.data.name, c] as const),
)
```

- [ ] **Step 4: Run tests and lint to verify they pass**

Run: `npx vitest run test/stats.test.ts && npm run lint`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/stats.ts src/commands/stats.ts src/commands/leaderboard.ts src/commands/index.ts test/stats.test.ts
git commit -m "feat: /stats and /leaderboard over derived aggregations"
```

---

### Task 12: `/config match-log` + result poster

**Files:**
- Create: `src/commands/config.ts`, `src/result-poster.ts`
- Modify: `src/commands/index.ts` (register `configCommand`)
- Test: `test/config-command.test.ts`, `test/result-poster.test.ts`

**Interfaces:**
- Consumes: `guildConfig` table (Task 1), `resultEmbed` (Task 6), `getGame` (Task 2).
- Produces: `configCommand` (admin, subcommand `match-log` with required channel option); `makeResultPoster(client: Pick<Client, 'channels'>, db: Db): (match: MatchRow, seats: SeatRow[]) => Promise<void>` — this is the `onResult` given to the webhook server in Task 15.

- [ ] **Step 1: Write the failing tests**

```ts
// test/config-command.test.ts
import { describe, expect, it, vi } from 'vitest'
import { configCommand } from '../src/commands/config.js'
import { guildConfig } from '../src/db/schema.js'
import { testDb } from './helpers/db.js'

function fakeInteraction(channelId: string) {
  return {
    guildId: 'g1',
    options: {
      getSubcommand: () => 'match-log',
      getChannel: (_name: string, _required: boolean) => ({ id: channelId, toString: () => `<#${channelId}>` }),
    },
    reply: vi.fn(async () => undefined),
  }
}

describe('/config match-log', () => {
  it('upserts the guild match-log channel', async () => {
    const db = await testDb()
    await configCommand.execute(fakeInteraction('c-log') as never, { db })
    await configCommand.execute(fakeInteraction('c-log2') as never, { db })
    const rows = await db.select().from(guildConfig)
    expect(rows).toEqual([{ guildId: 'g1', matchLogChannelId: 'c-log2' }])
  })

  it('declares admin default permissions', () => {
    const json = configCommand.data.toJSON()
    expect(json.default_member_permissions).toBeDefined()
  })
})
```

```ts
// test/result-poster.test.ts
import { describe, expect, it, vi } from 'vitest'
import { guildConfig } from '../src/db/schema.js'
import type { MatchRow, SeatRow } from '../src/db/schema.js'
import { makeResultPoster } from '../src/result-poster.js'
import { testDb } from './helpers/db.js'

const MATCH: MatchRow = {
  id: 1, guildId: 'g1', channelId: 'c-launch', gameSlug: 'catan', code: 'ABCD',
  joinUrl: 'http://p.example/?join=ABCD', callbackToken: 'cb_x', status: 'completed',
  createdByDiscordId: 'u1', players: 3, bots: 0,
  createdAt: new Date(), expiresAt: null, finishedAt: new Date(),
}
const SEATS: SeatRow[] = [
  { id: 1, matchId: 1, seatToken: 'st_a', discordUserId: 'u2', displayName: 'Alice', placement: 1, winner: true, stats: { vp: 10 } },
]

function fakeClient(known: Record<string, { send: ReturnType<typeof vi.fn> } | null>) {
  return {
    channels: {
      fetch: vi.fn(async (id: string) => {
        const ch = known[id]
        if (ch === null || ch === undefined) throw new Error('Unknown Channel')
        return { isSendable: () => true, send: ch.send }
      }),
    },
  }
}

describe('result poster', () => {
  it('posts to the launch channel and mirrors to the match log', async () => {
    const db = await testDb()
    await db.insert(guildConfig).values({ guildId: 'g1', matchLogChannelId: 'c-log' })
    const launch = { send: vi.fn(async () => undefined) }
    const log = { send: vi.fn(async () => undefined) }
    await makeResultPoster(fakeClient({ 'c-launch': launch, 'c-log': log }) as never, db)(MATCH, SEATS)
    expect(launch.send).toHaveBeenCalledTimes(1)
    expect(log.send).toHaveBeenCalledTimes(1)
  })

  it('survives a deleted channel and still posts the other one', async () => {
    const db = await testDb()
    await db.insert(guildConfig).values({ guildId: 'g1', matchLogChannelId: 'c-log' })
    const log = { send: vi.fn(async () => undefined) }
    await expect(
      makeResultPoster(fakeClient({ 'c-launch': null, 'c-log': log }) as never, db)(MATCH, SEATS),
    ).resolves.toBeUndefined()
    expect(log.send).toHaveBeenCalledTimes(1)
  })

  it('does not double-post when match log equals the launch channel or is unset', async () => {
    const db = await testDb()
    const launch = { send: vi.fn(async () => undefined) }
    await makeResultPoster(fakeClient({ 'c-launch': launch }) as never, db)(MATCH, SEATS)
    expect(launch.send).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config-command.test.ts test/result-poster.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the implementations**

```ts
// src/commands/config.ts
import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { getDb, type Db } from '../db/index.js'
import { guildConfig } from '../db/schema.js'

export interface ConfigDeps {
  db: Db
}

export const configCommand = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Steward server configuration')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('match-log')
        .setDescription('Channel where every match result is archived')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Archive channel').addChannelTypes(ChannelType.GuildText).setRequired(true),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction, deps: ConfigDeps = { db: getDb() }): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral })
      return
    }
    const channel = interaction.options.getChannel('channel', true)
    await deps.db
      .insert(guildConfig)
      .values({ guildId: interaction.guildId, matchLogChannelId: channel.id })
      .onConflictDoUpdate({ target: guildConfig.guildId, set: { matchLogChannelId: channel.id } })
    await interaction.reply({ content: `Match results will be archived in ${channel.toString()}.`, flags: MessageFlags.Ephemeral })
  },
}
```

```ts
// src/result-poster.ts
import type { Client } from 'discord.js'
import { eq } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { guildConfig, type MatchRow, type SeatRow } from './db/schema.js'
import { resultEmbed } from './embeds.js'
import { getGame } from './games.js'

/** Posts the result embed to the launch channel, mirrored to the match-log if configured. */
export function makeResultPoster(client: Pick<Client, 'channels'>, db: Db) {
  return async (match: MatchRow, seatRows: SeatRow[]): Promise<void> => {
    const game = getGame(match.gameSlug)
    if (!game) {
      console.error(`[results] match ${match.id} references unknown game ${match.gameSlug}`)
      return
    }
    const embed = resultEmbed(game, match, seatRows)
    const [cfg] = await db.select().from(guildConfig).where(eq(guildConfig.guildId, match.guildId))
    const targets = [match.channelId]
    if (cfg?.matchLogChannelId && cfg.matchLogChannelId !== match.channelId) targets.push(cfg.matchLogChannelId)
    for (const channelId of targets) {
      try {
        const channel = await client.channels.fetch(channelId)
        if (channel?.isSendable()) await channel.send({ embeds: [embed] })
      } catch (e) {
        console.error(`[results] could not post to channel ${channelId}:`, e)
      }
    }
  }
}
```

Register `configCommand` in `src/commands/index.ts` the same way as Task 11.

- [ ] **Step 4: Run tests and lint to verify they pass**

Run: `npx vitest run test/config-command.test.ts test/result-poster.test.ts && npm run lint`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/config.ts src/result-poster.ts src/commands/index.ts test/config-command.test.ts test/result-poster.test.ts
git commit -m "feat: /config match-log and best-effort result posting with mirror"
```

---

### Task 13: `/roles setup` + role select menu

**Files:**
- Create: `src/commands/roles.ts`, `src/interactions/roles.ts`
- Modify: `src/commands/index.ts` (register `rolesCommand`)
- Test: `test/roles.test.ts`

**Interfaces:**
- Consumes: registry (Task 2), `gameRoles` table (Task 1).
- Produces: `rolesCommand` (admin, subcommand `setup`); `isRoleSelect(customId: string): boolean` (customId `roles:pick`); `handleRoleSelect(interaction: StringSelectMenuInteraction, db?: Db): Promise<void>`.

Behavior: `setup` finds a guild role named after each registry game (creating it if missing), upserts `game_roles`, and posts a single-pick select menu. Picking a game toggles that role on the member with an ephemeral confirmation. Requires the bot's own role to sit above the game roles — document in README (Task 15).

- [ ] **Step 1: Write the failing test**

```ts
// test/roles.test.ts
import { describe, expect, it, vi } from 'vitest'
import { rolesCommand } from '../src/commands/roles.js'
import { gameRoles } from '../src/db/schema.js'
import { handleRoleSelect, isRoleSelect } from '../src/interactions/roles.js'
import { testDb } from './helpers/db.js'

function fakeSetupInteraction(existingRoleNames: Record<string, string> = {}) {
  const created: string[] = []
  return {
    created,
    guildId: 'g1',
    guild: {
      roles: {
        cache: {
          find: (fn: (r: { name: string; id: string }) => boolean) => {
            const found = Object.entries(existingRoleNames).map(([name, id]) => ({ name, id })).find(fn)
            return found
          },
        },
        create: vi.fn(async ({ name }: { name: string }) => {
          created.push(name)
          return { id: `r-${name}`, name }
        }),
      },
    },
    options: { getSubcommand: () => 'setup' },
    reply: vi.fn(async () => undefined),
  }
}

describe('/roles setup', () => {
  it('creates missing roles, stores the mapping, and posts a select menu', async () => {
    const db = await testDb()
    const i = fakeSetupInteraction()
    await rolesCommand.execute(i as never, { db })
    expect(i.created).toEqual(['CATAN (Meridian)'])
    const rows = await db.select().from(gameRoles)
    expect(rows).toEqual([{ guildId: 'g1', gameSlug: 'catan', roleId: 'r-CATAN (Meridian)' }])
    const reply = JSON.stringify(i.reply.mock.calls[0]![0])
    expect(reply).toContain('roles:pick')
  })

  it('reuses an existing role with the game name', async () => {
    const db = await testDb()
    const i = fakeSetupInteraction({ 'CATAN (Meridian)': 'r-existing' })
    await rolesCommand.execute(i as never, { db })
    expect(i.created).toEqual([])
    const rows = await db.select().from(gameRoles)
    expect(rows[0]!.roleId).toBe('r-existing')
  })
})

describe('role select', () => {
  it('recognizes its customId', () => {
    expect(isRoleSelect('roles:pick')).toBe(true)
    expect(isRoleSelect('join:7')).toBe(false)
  })

  it('toggles the mapped role on the member', async () => {
    const db = await testDb()
    await db.insert(gameRoles).values({ guildId: 'g1', gameSlug: 'catan', roleId: 'r1' })
    const add = vi.fn(async () => undefined)
    const remove = vi.fn(async () => undefined)
    const base = {
      guildId: 'g1',
      values: ['catan'],
      reply: vi.fn(async () => undefined),
    }
    const without = { ...base, member: { roles: { cache: { has: () => false }, add, remove } } }
    await handleRoleSelect(without as never, db)
    expect(add).toHaveBeenCalledWith('r1')
    const withRole = { ...base, member: { roles: { cache: { has: () => true }, add, remove } } }
    await handleRoleSelect(withRole as never, db)
    expect(remove).toHaveBeenCalledWith('r1')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/roles.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the implementations**

```ts
// src/commands/roles.ts
import {
  ActionRowBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { getDb, type Db } from '../db/index.js'
import { gameRoles } from '../db/schema.js'
import { games } from '../games.js'

export interface RolesDeps {
  db: Db
}

export const rolesCommand = {
  data: new SlashCommandBuilder()
    .setName('roles')
    .setDescription('Game role self-assignment')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) => sc.setName('setup').setDescription('Create game roles and post the self-assign menu')),

  async execute(interaction: ChatInputCommandInteraction, deps: RolesDeps = { db: getDb() }): Promise<void> {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral })
      return
    }
    for (const game of games) {
      const existing = interaction.guild.roles.cache.find((r) => r.name === game.name)
      const role = existing ?? (await interaction.guild.roles.create({ name: game.name, mentionable: true }))
      await deps.db
        .insert(gameRoles)
        .values({ guildId: interaction.guildId, gameSlug: game.slug, roleId: role.id })
        .onConflictDoUpdate({ target: [gameRoles.guildId, gameRoles.gameSlug], set: { roleId: role.id } })
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId('roles:pick')
      .setPlaceholder('Pick a game to toggle its role')
      .addOptions(games.map((g) => ({ label: g.name, value: g.slug })))
    await interaction.reply({
      content: 'Grab a game role to get pinged for game nights:',
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    })
  },
}
```

```ts
// src/interactions/roles.ts
import { MessageFlags, type GuildMember, type StringSelectMenuInteraction } from 'discord.js'
import { and, eq } from 'drizzle-orm'
import { getDb, type Db } from '../db/index.js'
import { gameRoles } from '../db/schema.js'
import { getGame } from '../games.js'

export function isRoleSelect(customId: string): boolean {
  return customId === 'roles:pick'
}

export async function handleRoleSelect(interaction: StringSelectMenuInteraction, db: Db = getDb()): Promise<void> {
  const slug = interaction.values[0]
  if (!slug || !interaction.guildId || !interaction.member) return
  const [row] = await db
    .select()
    .from(gameRoles)
    .where(and(eq(gameRoles.guildId, interaction.guildId), eq(gameRoles.gameSlug, slug)))
  if (!row) {
    await interaction.reply({ content: 'No role is configured for that game — ask an admin to run /roles setup.', flags: MessageFlags.Ephemeral })
    return
  }
  const member = interaction.member as GuildMember
  const name = getGame(slug)?.name ?? slug
  try {
    if (member.roles.cache.has(row.roleId)) {
      await member.roles.remove(row.roleId)
      await interaction.reply({ content: `Removed the **${name}** role.`, flags: MessageFlags.Ephemeral })
    } else {
      await member.roles.add(row.roleId)
      await interaction.reply({ content: `Gave you the **${name}** role.`, flags: MessageFlags.Ephemeral })
    }
  } catch (e) {
    console.error(`[roles] toggle failed for role ${row.roleId}:`, e)
    await interaction.reply({ content: 'Could not change that role — it may have been deleted, or the bot lacks permission.', flags: MessageFlags.Ephemeral })
  }
}
```

Register `rolesCommand` in `src/commands/index.ts`.

- [ ] **Step 4: Run tests and lint to verify they pass**

Run: `npx vitest run test/roles.test.ts && npm run lint`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/roles.ts src/interactions/roles.ts src/commands/index.ts test/roles.test.ts
git commit -m "feat: /roles setup with self-assign select menu"
```

---

### Task 14: Scheduler (expiry sweep + `/gamenight`)

**Files:**
- Create: `src/scheduler.ts`, `src/commands/gamenight.ts`
- Modify: `src/commands/index.ts` (register `gamenightCommand`)
- Test: `test/scheduler.test.ts`, `test/gamenight.test.ts`

**Interfaces:**
- Consumes: tables (Task 1), `gameRoles`.
- Produces: `sweepExpiredMatches(db: Db, now?: Date): Promise<number>`; `interface AnnounceDeps { db: Db; post: (channelId: string, content: string) => Promise<void>; now?: () => Date }`; `fireDueAnnouncements(deps: AnnounceDeps): Promise<number>`; `startScheduler(deps: AnnounceDeps, intervalMs?: number): () => void`; `gamenightCommand` (admin; subcommands `schedule` [channel, message, game?, first_in_hours, every_days], `list`, `cancel` [id]).

Sweep policy (from spec + one pragmatic backstop): `pending` matches past `expiresAt` → `expired` (nobody joined); `active` matches more than 24h past `expiresAt` → `expired` (game died without a callback — the webhook remains the source of truth and a late `completed` still wins via Task 9).

- [ ] **Step 1: Write the failing tests**

```ts
// test/scheduler.test.ts
import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db } from '../src/db/index.js'
import { gameRoles, matches, scheduledAnnouncements } from '../src/db/schema.js'
import { fireDueAnnouncements, sweepExpiredMatches } from '../src/scheduler.js'
import { testDb } from './helpers/db.js'

const NOW = new Date('2026-08-27T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000)

async function match(db: Db, status: 'pending' | 'active' | 'completed', expiresAt: Date) {
  const [m] = await db
    .insert(matches)
    .values({
      guildId: 'g1', channelId: 'c1', gameSlug: 'catan', code: `C${Math.floor(Math.random() * 1e6)}`,
      joinUrl: 'http://p.example/?join=X', callbackToken: `cb_${Math.random()}`,
      createdByDiscordId: 'u1', players: 4, bots: 0, status, expiresAt,
    })
    .returning()
  return m!
}

describe('sweepExpiredMatches', () => {
  it('expires pending matches past expiry and long-stale active matches, leaves the rest', async () => {
    const db = await testDb()
    const stalePending = await match(db, 'pending', hoursAgo(1))
    const freshPending = await match(db, 'pending', hoursAgo(-1))
    const staleActive = await match(db, 'active', hoursAgo(25))
    const runningActive = await match(db, 'active', hoursAgo(2))
    const done = await match(db, 'completed', hoursAgo(30))
    expect(await sweepExpiredMatches(db, NOW)).toBe(2)
    const byId = async (id: number) => (await db.select().from(matches).where(eq(matches.id, id)))[0]!.status
    expect(await byId(stalePending.id)).toBe('expired')
    expect(await byId(freshPending.id)).toBe('pending')
    expect(await byId(staleActive.id)).toBe('expired')
    expect(await byId(runningActive.id)).toBe('active')
    expect(await byId(done.id)).toBe('completed')
  })
})

describe('fireDueAnnouncements', () => {
  it('posts due announcements with the game role ping and advances nextRunAt past now', async () => {
    const db = await testDb()
    await db.insert(gameRoles).values({ guildId: 'g1', gameSlug: 'catan', roleId: 'r1' })
    const [a] = await db
      .insert(scheduledAnnouncements)
      .values({ guildId: 'g1', channelId: 'c1', gameSlug: 'catan', message: 'Game night!', nextRunAt: hoursAgo(1), intervalDays: 7 })
      .returning()
    const post = vi.fn(async () => undefined)
    expect(await fireDueAnnouncements({ db, post, now: () => NOW })).toBe(1)
    expect(post).toHaveBeenCalledWith('c1', '<@&r1> Game night!')
    const [after] = await db.select().from(scheduledAnnouncements).where(eq(scheduledAnnouncements.id, a!.id))
    expect(after!.nextRunAt.getTime()).toBeGreaterThan(NOW.getTime())
    // second sweep: nothing due
    expect(await fireDueAnnouncements({ db, post, now: () => NOW })).toBe(0)
  })

  it('a failing post still advances the row so one bad channel cannot spam or stall', async () => {
    const db = await testDb()
    await db.insert(scheduledAnnouncements).values({
      guildId: 'g1', channelId: 'c-dead', gameSlug: null, message: 'Hi', nextRunAt: hoursAgo(1), intervalDays: 1,
    })
    const post = vi.fn(async () => {
      throw new Error('Unknown Channel')
    })
    expect(await fireDueAnnouncements({ db, post, now: () => NOW })).toBe(0)
    const rows = await db.select().from(scheduledAnnouncements)
    expect(rows[0]!.nextRunAt.getTime()).toBeGreaterThan(NOW.getTime())
  })

  it('ignores disabled announcements', async () => {
    const db = await testDb()
    await db.insert(scheduledAnnouncements).values({
      guildId: 'g1', channelId: 'c1', gameSlug: null, message: 'Hi', nextRunAt: hoursAgo(1), intervalDays: 1, enabled: false,
    })
    const post = vi.fn(async () => undefined)
    expect(await fireDueAnnouncements({ db, post, now: () => NOW })).toBe(0)
  })
})
```

```ts
// test/gamenight.test.ts
import { describe, expect, it, vi } from 'vitest'
import { gamenightCommand } from '../src/commands/gamenight.js'
import { scheduledAnnouncements } from '../src/db/schema.js'
import { testDb } from './helpers/db.js'

function fakeInteraction(sub: string, opts: Record<string, unknown> = {}) {
  return {
    guildId: 'g1',
    options: {
      getSubcommand: () => sub,
      getChannel: () => opts['channel'] ?? { id: 'c1', toString: () => '<#c1>' },
      getString: (name: string) => (opts[name] as string | undefined) ?? null,
      getInteger: (name: string) => (opts[name] as number | undefined) ?? null,
    },
    reply: vi.fn(async () => undefined),
  }
}

describe('/gamenight', () => {
  it('schedule inserts an enabled announcement with computed nextRunAt', async () => {
    const db = await testDb()
    const i = fakeInteraction('schedule', { message: 'Game night!', game: 'catan', first_in_hours: 2, every_days: 7 })
    await gamenightCommand.execute(i as never, { db })
    const rows = await db.select().from(scheduledAnnouncements)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.message).toBe('Game night!')
    expect(rows[0]!.intervalDays).toBe(7)
    expect(rows[0]!.enabled).toBe(true)
    expect(rows[0]!.nextRunAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('list shows entries and cancel disables by id', async () => {
    const db = await testDb()
    const [a] = await db
      .insert(scheduledAnnouncements)
      .values({ guildId: 'g1', channelId: 'c1', gameSlug: null, message: 'Hi', nextRunAt: new Date(), intervalDays: 7 })
      .returning()
    const list = fakeInteraction('list')
    await gamenightCommand.execute(list as never, { db })
    expect(JSON.stringify(list.reply.mock.calls[0]![0])).toContain('Hi')
    const cancel = fakeInteraction('cancel', { id: a!.id })
    await gamenightCommand.execute(cancel as never, { db })
    const rows = await db.select().from(scheduledAnnouncements)
    expect(rows[0]!.enabled).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/scheduler.test.ts test/gamenight.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the implementations**

```ts
// src/scheduler.ts
import { and, eq, lt, lte } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { gameRoles, matches, scheduledAnnouncements } from './db/schema.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Pending past expiry → expired (nobody joined). Active >24h past expiry → expired
 * (game died without a callback; a late `completed` webhook still wins — see results.ts).
 */
export async function sweepExpiredMatches(db: Db, now: Date = new Date()): Promise<number> {
  const pending = await db
    .update(matches)
    .set({ status: 'expired' })
    .where(and(eq(matches.status, 'pending'), lt(matches.expiresAt, now)))
    .returning({ id: matches.id })
  const stale = await db
    .update(matches)
    .set({ status: 'expired' })
    .where(and(eq(matches.status, 'active'), lt(matches.expiresAt, new Date(now.getTime() - DAY_MS))))
    .returning({ id: matches.id })
  return pending.length + stale.length
}

export interface AnnounceDeps {
  db: Db
  post: (channelId: string, content: string) => Promise<void>
  now?: () => Date
}

export async function fireDueAnnouncements(deps: AnnounceDeps): Promise<number> {
  const now = deps.now?.() ?? new Date()
  const due = await deps.db
    .select()
    .from(scheduledAnnouncements)
    .where(and(eq(scheduledAnnouncements.enabled, true), lte(scheduledAnnouncements.nextRunAt, now)))
  let fired = 0
  for (const a of due) {
    try {
      let content = a.message
      if (a.gameSlug) {
        const [role] = await deps.db
          .select()
          .from(gameRoles)
          .where(and(eq(gameRoles.guildId, a.guildId), eq(gameRoles.gameSlug, a.gameSlug)))
        if (role) content = `<@&${role.roleId}> ${content}`
      }
      await deps.post(a.channelId, content)
      fired++
    } catch (e) {
      console.error(`[gamenight] announcement ${a.id} failed:`, e)
    } finally {
      // Advance even on failure so one bad row can't spam every sweep.
      const next = new Date(a.nextRunAt.getTime())
      while (next.getTime() <= now.getTime()) next.setTime(next.getTime() + a.intervalDays * DAY_MS)
      await deps.db.update(scheduledAnnouncements).set({ nextRunAt: next }).where(eq(scheduledAnnouncements.id, a.id))
    }
  }
  return fired
}

/** Poll loop; each job is isolated so one bad row can't stall the rest. Returns a stop function. */
export function startScheduler(deps: AnnounceDeps, intervalMs = 30_000): () => void {
  const tick = (): void => {
    sweepExpiredMatches(deps.db).catch((e) => console.error('[sweep] failed:', e))
    fireDueAnnouncements(deps).catch((e) => console.error('[gamenight] sweep failed:', e))
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
```

```ts
// src/commands/gamenight.ts
import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { and, eq } from 'drizzle-orm'
import { getDb, type Db } from '../db/index.js'
import { scheduledAnnouncements } from '../db/schema.js'

export interface GamenightDeps {
  db: Db
}

export const gamenightCommand = {
  data: new SlashCommandBuilder()
    .setName('gamenight')
    .setDescription('Scheduled game-night announcements')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('schedule')
        .setDescription('Schedule a recurring announcement')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Where to post').addChannelTypes(ChannelType.GuildText).setRequired(true),
        )
        .addStringOption((o) => o.setName('message').setDescription('Announcement text').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('first_in_hours').setDescription('Hours until the first post (default 1)').setMinValue(0).setMaxValue(720),
        )
        .addIntegerOption((o) =>
          o.setName('every_days').setDescription('Repeat every N days (default 7)').setMinValue(1).setMaxValue(90),
        )
        .addStringOption((o) => o.setName('game').setDescription('Game whose role gets pinged')),
    )
    .addSubcommand((sc) => sc.setName('list').setDescription('List scheduled announcements'))
    .addSubcommand((sc) =>
      sc
        .setName('cancel')
        .setDescription('Cancel a scheduled announcement')
        .addIntegerOption((o) => o.setName('id').setDescription('Announcement id (see /gamenight list)').setRequired(true)),
    ),

  async execute(interaction: ChatInputCommandInteraction, deps: GamenightDeps = { db: getDb() }): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral })
      return
    }
    const sub = interaction.options.getSubcommand()
    if (sub === 'schedule') {
      const channel = interaction.options.getChannel('channel', true)
      const message = interaction.options.getString('message', true)
      const firstInHours = interaction.options.getInteger('first_in_hours') ?? 1
      const everyDays = interaction.options.getInteger('every_days') ?? 7
      const gameSlug = interaction.options.getString('game')
      const nextRunAt = new Date(Date.now() + firstInHours * 3600_000)
      const [row] = await deps.db
        .insert(scheduledAnnouncements)
        .values({ guildId: interaction.guildId, channelId: channel.id, gameSlug, message, nextRunAt, intervalDays: everyDays })
        .returning()
      await interaction.reply({
        content: `Scheduled #${row!.id}: first post <t:${Math.floor(nextRunAt.getTime() / 1000)}:R>, then every ${everyDays} day${everyDays === 1 ? '' : 's'}.`,
        flags: MessageFlags.Ephemeral,
      })
    } else if (sub === 'list') {
      const rows = await deps.db
        .select()
        .from(scheduledAnnouncements)
        .where(and(eq(scheduledAnnouncements.guildId, interaction.guildId), eq(scheduledAnnouncements.enabled, true)))
      const lines = rows.map(
        (r) => `**#${r.id}** <#${r.channelId}> every ${r.intervalDays}d, next <t:${Math.floor(r.nextRunAt.getTime() / 1000)}:R> — ${r.message}`,
      )
      await interaction.reply({ content: lines.join('\n') || 'No scheduled announcements.', flags: MessageFlags.Ephemeral })
    } else if (sub === 'cancel') {
      const id = interaction.options.getInteger('id', true)
      const updated = await deps.db
        .update(scheduledAnnouncements)
        .set({ enabled: false })
        .where(and(eq(scheduledAnnouncements.id, id), eq(scheduledAnnouncements.guildId, interaction.guildId)))
        .returning()
      await interaction.reply({
        content: updated.length > 0 ? `Cancelled announcement #${id}.` : `No announcement #${id} in this server.`,
        flags: MessageFlags.Ephemeral,
      })
    }
  },
}
```

Register `gamenightCommand` in `src/commands/index.ts`.

- [ ] **Step 4: Run tests and lint to verify they pass**

Run: `npx vitest run test/scheduler.test.ts test/gamenight.test.ts && npm run lint`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts src/commands/gamenight.ts src/commands/index.ts test/scheduler.test.ts test/gamenight.test.ts
git commit -m "feat: expiry sweep + /gamenight scheduled announcements"
```

---

### Task 15: Wiring, docs, and end-to-end test

**Files:**
- Modify: `src/index.ts`, `.env.example`, `README.md`
- Create: `docs/GAME-ADAPTER.md`
- Test: `test/e2e.test.ts`

**Interfaces:**
- Consumes: everything above. No new exports.

- [ ] **Step 1: Write the failing end-to-end test**

```ts
// test/e2e.test.ts — /play → Join → result webhook → embeds + stats
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { playCommand, type PlayDeps } from '../src/commands/play.js'
import { matches } from '../src/db/schema.js'
import { handleJoinButton } from '../src/interactions/join.js'
import { launchMatch } from '../src/matches.js'
import { playerStats } from '../src/stats.js'
import { createWebhookServer } from '../src/webhook-server.js'
import { testDb } from './helpers/db.js'

let server: http.Server | undefined
afterEach(() => server?.close())

const LAUNCHED = { code: 'ABCD', joinUrl: 'http://play.example/?join=ABCD', expiresAt: '2026-08-27T12:00:00.000Z' }

describe('end to end', () => {
  it('runs the full match lifecycle against a mocked game', async () => {
    const db = await testDb()

    // 1. /play — the mocked game answers 201
    const deps: PlayDeps = {
      db,
      launch: (args) => launchMatch({ ...args, createMatch: vi.fn(async () => LAUNCHED) }),
      publicBaseUrl: 'http://steward.example',
    }
    const play = {
      options: { getString: () => 'catan', getInteger: (n: string) => (n === 'players' ? 3 : 0) },
      guildId: 'g1', channelId: 'c1', user: { id: 'u1', displayName: 'Ayo' },
      deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined), reply: vi.fn(async () => undefined),
    }
    await playCommand.execute(play as never, deps)
    const [match] = await db.select().from(matches)
    expect(match).toBeDefined()

    // 2. Join — Alice clicks the button and gets a personal seat link
    const join = { customId: `join:${match!.id}`, user: { id: 'u2', displayName: 'Alice' }, reply: vi.fn(async () => undefined) }
    await handleJoinButton(join as never, db)
    const link = (join.reply.mock.calls[0]![0] as { content: string }).content
    const seatToken = /seat=(st_[A-Za-z0-9_-]+)/.exec(link)![1]!

    // 3. The game reports the result to the webhook Steward handed it
    const onResult = vi.fn(async () => undefined)
    server = createWebhookServer({ db, onResult })
    await new Promise<void>((r) => server!.listen(0, r))
    const port = (server.address() as AddressInfo).port
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/results`, {
      method: 'POST',
      headers: { authorization: `Bearer ${match!.callbackToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'ABCD',
        status: 'completed',
        seats: [{ seatToken, displayName: 'Alice', placement: 1, winner: true, stats: { vp: 10 } }],
      }),
    })
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1))

    // 4. Stats reflect the completed match
    const stats = await playerStats(db, 'g1', 'u2')
    expect(stats).toEqual([{ gameSlug: 'catan', games: 1, wins: 1, winRate: 1 }])
  })
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/e2e.test.ts`
Expected: PASS already (it composes tested pieces — if it fails, fix the integration seam it exposes before continuing).

- [ ] **Step 3: Rewrite `src/index.ts` wiring**

```ts
// src/index.ts
import 'dotenv/config'
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js'
import { commands } from './commands/index.js'
import { getDb } from './db/index.js'
import { handleJoinButton, isJoinButton } from './interactions/join.js'
import { handleRoleSelect, isRoleSelect } from './interactions/roles.js'
import { makeResultPoster } from './result-poster.js'
import { startScheduler } from './scheduler.js'
import { createWebhookServer } from './webhook-server.js'

const token = process.env.DISCORD_TOKEN
if (!token) {
  console.error('DISCORD_TOKEN is not set (see .env.example)')
  process.exit(1)
}

const db = getDb()
const client = new Client({ intents: [GatewayIntentBits.Guilds] })

client.once(Events.ClientReady, (c) => {
  console.log(`steward ready as ${c.user.tag}`)
})

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await commands.get(interaction.commandName)?.execute(interaction)
    } else if (interaction.isAutocomplete()) {
      await commands.get(interaction.commandName)?.autocomplete?.(interaction)
    } else if (interaction.isButton() && isJoinButton(interaction.customId)) {
      await handleJoinButton(interaction)
    } else if (interaction.isStringSelectMenu() && isRoleSelect(interaction.customId)) {
      await handleRoleSelect(interaction)
    }
  } catch (e) {
    console.error('interaction failed:', e)
    if (interaction.isRepliable()) {
      const content = 'Something went wrong running that command.'
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content }).catch(() => undefined)
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined)
    }
  }
})

const webhook = createWebhookServer({ db, onResult: makeResultPoster(client, db) })
const port = Number(process.env.WEBHOOK_PORT ?? 8787)
webhook.listen(port, () => console.log(`result webhooks on :${port}`))

startScheduler({
  db,
  post: async (channelId, content) => {
    const channel = await client.channels.fetch(channelId)
    if (channel?.isSendable()) await channel.send({ content })
  },
})

void client.login(token)
```

- [ ] **Step 4: Update `.env.example` (append)**

```bash
# Postgres connection (drizzle). Run `npm run db:migrate` after changing schema.
DATABASE_URL=postgres://localhost:5432/steward
# Port for the inbound result-webhook HTTP server.
WEBHOOK_PORT=8787
# Public base URL games use to reach the webhook (callback.url = <this>/webhooks/results).
PUBLIC_BASE_URL=http://localhost:8787
```

- [ ] **Step 5: Write `docs/GAME-ADAPTER.md`**

Publish the adapter contract from the design spec as a standalone doc — copy sections "Launch", "Per-player join links", and "Results" from `docs/superpowers/specs/2026-08-26-steward-game-platform-design.md` (§ "The game-adapter contract (v1)") verbatim, prefaced by:

```markdown
# Steward Game-Adapter Contract (v1)

Any game implementing this HTTP contract can enter Steward's library via a
`src/games.ts` registry entry. Meridian's `DISCORD-LAUNCH.md` (v0) is
superseded by this document and keeps only Catan-specific notes.
```

Also update `README.md`: one paragraph on what Steward is now (game platform), the command surface list, env vars, `npm run db:migrate` + `npm run deploy-commands` setup steps, and a note that `/roles setup` needs the bot's role above the game roles plus Manage Roles permission.

- [ ] **Step 6: Full verification**

Run: `npm test && npm run lint`
Expected: entire suite PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts .env.example README.md docs/GAME-ADAPTER.md test/e2e.test.ts
git commit -m "feat: wire bot, webhook server, and scheduler; adapter contract doc + e2e"
```

---

## Out of scope for this plan

The Meridian-side changes (accept/store `callback`, `?seat=` claim path, result reporting, abandonment) are §"Meridian-side changes" in the spec and belong in Meridian's own plan — nothing here depends on them; Steward is fully testable against the mocked game.

## Deployment note (not a task)

Steward needs a Postgres instance and a publicly reachable `PUBLIC_BASE_URL` for real games to deliver webhooks. For local play with Meridian on the same machine, `http://localhost:8787` works as-is.
