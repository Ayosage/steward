import { describe, expect, it } from 'vitest'
import type { Db } from '../src/db/index.js'
import { matches, seats } from '../src/db/schema.js'
import { leaderboard, playerStats } from '../src/stats.js'
import { testDb } from './helpers/db.js'

let nextCode = 0
async function finishedMatch(
  db: Db,
  guildId: string,
  results: Array<{ user: string | null; winner: boolean }>,
  status: 'completed' | 'abandoned' = 'completed',
  gameSlug = 'catan',
) {
  const code = `M${nextCode++}`
  const [m] = await db
    .insert(matches)
    .values({
      guildId, channelId: 'c1', gameSlug, code, joinUrl: `http://p.example/?join=${code}`,
      callbackToken: `cb_${code}`, createdByDiscordId: 'u0',
      players: results.length, bots: 0, status, finishedAt: new Date(),
    })
    .returning()
  await db.insert(seats).values(
    results.map((r, i) => ({
      matchId: m!.id, seatToken: `st_${code}_${i}`, discordUserId: r.user,
      displayName: r.user ?? 'Anon', placement: i + 1, winner: r.winner,
    })),
  )
}

describe('playerStats', () => {
  it('computes games, wins, and win rate per game, excluding abandoned matches', async () => {
    const db = await testDb()
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: true }, { user: 'u2', winner: false }])
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: false }, { user: 'u2', winner: true }])
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: false }, { user: 'u2', winner: true }])
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: true }], 'abandoned')
    const rows = await playerStats(db, 'g1', 'u1')
    expect(rows).toEqual([{ gameSlug: 'catan', games: 3, wins: 1, winRate: 1 / 3 }])
  })

  it('scopes to the guild', async () => {
    const db = await testDb()
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: true }])
    await finishedMatch(db, 'g2', [{ user: 'u1', winner: true }])
    const rows = await playerStats(db, 'g1', 'u1')
    expect(rows[0]!.games).toBe(1)
  })
})

describe('leaderboard', () => {
  it('ranks by wins then win rate and skips anonymous seats', async () => {
    const db = await testDb()
    // u1: 2 wins / 4 games (50%); u2: 2 wins / 2 games (100%) → tiebreak on rate; u3: 0 wins; one anonymous seat
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: true }, { user: null, winner: false }])
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: true }, { user: 'u3', winner: false }])
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: false }, { user: 'u2', winner: true }])
    await finishedMatch(db, 'g1', [{ user: 'u1', winner: false }, { user: 'u2', winner: true }])
    const rows = await leaderboard(db, 'g1', 'catan')
    expect(rows.map((r) => r.discordUserId)).toEqual(['u2', 'u1', 'u3'])
    expect(rows[0]).toEqual({ discordUserId: 'u2', games: 2, wins: 2, winRate: 1 })
  })
})
