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
