// /play → Join → result webhook → embeds + stats
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
    const join = {
      customId: `join:${match!.id}`,
      user: { id: 'u2', displayName: 'Alice' },
      reply: vi.fn(async (_opts: { content: string }) => undefined),
    }
    await handleJoinButton(join as never, db)
    const link = join.reply.mock.calls[0]![0].content
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
