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
