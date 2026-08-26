import { describe, expect, it, vi } from 'vitest'
import { createMeridianMatch, MeridianLaunchError } from '../src/meridian.js'

const ENV = { apiUrl: 'http://game.example', launchToken: 'sekrit' }

function okFetch(body: unknown, status = 201) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

describe('createMeridianMatch', () => {
  it('POSTs the contract body with the bearer token and returns the launch info', async () => {
    const fetchFn = okFetch({ code: 'ABCD', joinUrl: 'http://play.example/?join=ABCD', expiresAt: '2026-08-26T12:00:00Z' })
    const match = await createMeridianMatch({ players: 6, bots: 2, seatNames: ['Ay'] }, ENV, fetchFn)
    expect(match).toEqual({ code: 'ABCD', joinUrl: 'http://play.example/?join=ABCD', expiresAt: '2026-08-26T12:00:00Z' })
    expect(fetchFn).toHaveBeenCalledWith('http://game.example/matches', {
      method: 'POST',
      headers: { authorization: 'Bearer sekrit', 'content-type': 'application/json' },
      body: JSON.stringify({ players: 6, bots: 2, seatNames: ['Ay'] }),
    })
  })

  it('throws a MeridianLaunchError carrying the server error message on 4xx', async () => {
    const fetchFn = okFetch({ error: 'players must be 3..8' }, 422)
    await expect(createMeridianMatch({ players: 6, bots: 0 }, ENV, fetchFn)).rejects.toThrow(MeridianLaunchError)
    await expect(createMeridianMatch({ players: 6, bots: 0 }, ENV, fetchFn)).rejects.toThrow(/players must be 3\.\.8/)
  })

  it('wraps a network failure in MeridianLaunchError', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(createMeridianMatch({ players: 4, bots: 0 }, ENV, fetchFn)).rejects.toThrow(MeridianLaunchError)
  })
})
