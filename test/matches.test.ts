import { describe, expect, it, vi } from 'vitest'
import { matches, seats } from '../src/db/schema.js'
import { GameLaunchError, type createGameMatch } from '../src/game-client.js'
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
  it('calls the game with a minted callback and the host seat, and persists both rows after 201', async () => {
    const db = await testDb()
    const createMatch = vi.fn<typeof createGameMatch>(async () => LAUNCHED)
    const { match: row, hostSeat, personalUrl } = await launchMatch({
      db, game: getGame('catan')!, players: 4, bots: 1,
      guildId: 'g1', channelId: 'c1', host: { id: 'u1', displayName: 'Ayo' },
      publicBaseUrl: 'http://steward.example', createMatch,
    })
    const body = createMatch.mock.calls[0]![1]
    expect(body.callback.url).toBe('http://steward.example/webhooks/results')
    expect(body.callback.token).toMatch(/^cb_/)
    expect(body.host).toEqual({ seatToken: expect.stringMatching(/^st_/), displayName: 'Ayo' })
    expect(row.code).toBe('ABCD')
    expect(row.status).toBe('pending')
    expect(row.createdByDiscordId).toBe('u1')
    expect(row.callbackToken).toBe(body.callback.token)
    expect(row.expiresAt).toEqual(new Date(LAUNCHED.expiresAt))
    expect(hostSeat.discordUserId).toBe('u1')
    expect(hostSeat.seatToken).toBe(body.host!.seatToken)
    expect(personalUrl).toBe(`http://play.example/?join=ABCD&seat=${hostSeat.seatToken}`)
    expect(await db.select().from(seats)).toHaveLength(1)
  })

  it('leaves no row when the game launch fails', async () => {
    const db = await testDb()
    const createMatch = vi.fn(async () => {
      throw new GameLaunchError('boom')
    })
    await expect(
      launchMatch({
        db, game: getGame('catan')!, players: 4, bots: 0,
        guildId: 'g1', channelId: 'c1', host: { id: 'u1', displayName: 'Ayo' },
        publicBaseUrl: 'http://steward.example', createMatch,
      }),
    ).rejects.toThrow(GameLaunchError)
    expect(await db.select().from(matches)).toHaveLength(0)
    expect(await db.select().from(seats)).toHaveLength(0)
  })
})
