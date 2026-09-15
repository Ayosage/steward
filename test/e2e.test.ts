// /play → host link → Join → seat link → result webhook → embeds + stats
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { playCommand, type PlayDeps } from '../src/commands/play.js'
import { matches } from '../src/db/schema.js'
import type { createGameMatch } from '../src/game-client.js'
import { handleJoinButton } from '../src/interactions/join.js'
import { launchMatch } from '../src/matches.js'
import { playerStats } from '../src/stats.js'
import { createWebhookServer } from '../src/webhook-server.js'
import { testDb } from './helpers/db.js'

let server: http.Server | undefined
afterEach(() => server?.close())

const LAUNCHED = { code: 'ABCD', joinUrl: 'http://play.example/?join=ABCD', expiresAt: '2026-09-12T12:00:00.000Z' }

describe('end to end', () => {
  it('runs the full /play → join → result lifecycle against a mocked game', async () => {
    const db = await testDb()

    // 1. /play launches the match with the invoker as host and hands them their link
    const createMatch = vi.fn<typeof createGameMatch>(async () => LAUNCHED)
    const playDeps: PlayDeps = {
      db,
      launch: (args) => launchMatch({ ...args, createMatch }),
      publicBaseUrl: 'http://steward.example',
    }
    const play = {
      options: { getString: () => 'catan' },
      guildId: 'g1',
      channelId: 'c1',
      user: { id: 'u1', displayName: 'Ayo' },
      reply: vi.fn(async () => ({ id: 'msg1' })),
      followUp: vi.fn(async (_opts: { content: string }) => undefined),
    }
    await playCommand.execute(play as never, playDeps)
    const [match] = await db.select().from(matches)
    expect(match).toBeDefined()
    const hostLink = play.followUp.mock.calls[0]![0].content
    expect(hostLink).toContain('seat=st_')
    expect(createMatch.mock.calls[0]![1].host?.seatToken).toBe(/seat=(st_[A-Za-z0-9_-]+)/.exec(hostLink)![1])

    // 2. Join: Alice clicks the match button and gets a personal seat link
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
    server = createWebhookServer({ db, onResult, isGatewayReady: () => true })
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
