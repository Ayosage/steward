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
