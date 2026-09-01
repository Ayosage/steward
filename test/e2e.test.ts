// /play → lobby join → Start → seat link → result webhook → embeds + stats
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { playCommand, type PlayDeps } from '../src/commands/play.js'
import { lobbies, matches } from '../src/db/schema.js'
import { handleJoinButton } from '../src/interactions/join.js'
import { handleLobbyButton, type LobbyDeps } from '../src/interactions/lobby.js'
import { launchMatch } from '../src/matches.js'
import { playerStats } from '../src/stats.js'
import { createWebhookServer } from '../src/webhook-server.js'
import { testDb } from './helpers/db.js'

let server: http.Server | undefined
afterEach(() => server?.close())

const LAUNCHED = { code: 'ABCD', joinUrl: 'http://play.example/?join=ABCD', expiresAt: '2026-09-02T12:00:00.000Z' }

function fakeButton(customId: string, userId: string, displayName = userId) {
  const i = {
    customId,
    user: { id: userId, displayName },
    deferred: false,
    replied: false,
    update: vi.fn(async (_opts: unknown) => undefined),
    reply: vi.fn(async (_opts: unknown) => undefined),
    deferUpdate: vi.fn(async () => {
      i.deferred = true
    }),
    editReply: vi.fn(async (_opts: unknown) => undefined),
    followUp: vi.fn(async (_opts: unknown) => undefined),
  }
  return i
}

describe('end to end', () => {
  it('runs the full lobby → match lifecycle against a mocked game', async () => {
    const db = await testDb()

    // 1. /play — the host opens a lobby
    const playDeps: PlayDeps = { db }
    const play = {
      options: { getString: () => 'catan' },
      guildId: 'g1', channelId: 'c1', user: { id: 'u1', displayName: 'Ayo' },
      reply: vi.fn(async () => ({ id: 'msg1' })),
    }
    await playCommand.execute(play as never, playDeps)
    const [lobby] = await db.select().from(lobbies)
    expect(lobby).toBeDefined()

    // 2. Alice and Bob join the lobby
    const lobbyDeps: LobbyDeps = {
      db,
      start: {
        launch: (args) => launchMatch({ ...args, createMatch: vi.fn(async () => LAUNCHED) }),
        publicBaseUrl: 'http://steward.example',
      },
    }
    await handleLobbyButton(fakeButton(`lobby:${lobby!.id}:join`, 'u2', 'Alice') as never, lobbyDeps)
    await handleLobbyButton(fakeButton(`lobby:${lobby!.id}:join`, 'u3', 'Bob') as never, lobbyDeps)

    // 3. The host starts the match — the mocked game answers 201
    const start = fakeButton(`lobby:${lobby!.id}:start`, 'u1', 'Ayo')
    await handleLobbyButton(start as never, lobbyDeps)
    const [match] = await db.select().from(matches)
    expect(match).toBeDefined()
    expect(match!.players).toBe(3)

    // 4. Join — Alice clicks the match button and gets a personal seat link
    const join = {
      customId: `join:${match!.id}`,
      user: { id: 'u2', displayName: 'Alice' },
      reply: vi.fn(async (_opts: { content: string }) => undefined),
    }
    await handleJoinButton(join as never, db)
    const link = join.reply.mock.calls[0]![0].content
    const seatToken = /seat=(st_[A-Za-z0-9_-]+)/.exec(link)![1]!

    // 5. The game reports the result to the webhook Steward handed it
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

    // 6. Stats reflect the completed match
    const stats = await playerStats(db, 'g1', 'u2')
    expect(stats).toEqual([{ gameSlug: 'catan', games: 1, wins: 1, winRate: 1 }])
  })
})
