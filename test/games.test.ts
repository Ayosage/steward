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
