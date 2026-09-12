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

  it('lists wordy with no bots and a 2 to 8 table', () => {
    expect(getGame('wordy')).toMatchObject({ slug: 'wordy', minPlayers: 2, maxPlayers: 8, maxBots: 0, defaultPlayers: 4, tokenEnvVar: 'WORDY_LAUNCH_TOKEN' })
    expect(validateLaunch(getGame('wordy')!, 4, 1)).toBe('bots must be 0..0')
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
