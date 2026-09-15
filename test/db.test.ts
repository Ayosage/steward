import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { matches, seats } from '../src/db/schema.js'
import { testDb } from './helpers/db.js'

describe('db schema', () => {
  it('indexes matches.code, which every result callback looks up', async () => {
    const db = await testDb()
    const { rows } = await db.execute(
      sql`select indexname from pg_indexes where tablename = 'matches' and indexname = 'matches_code_idx'`,
    )
    expect(rows).toHaveLength(1)
    const plan = await db.execute(sql`explain select * from matches where code = 'ABCD'`)
    expect(JSON.stringify(plan.rows)).not.toContain('Seq Scan')
  })

  it('inserts and reads a match with a seat; status defaults to pending', async () => {
    const db = await testDb()
    const [m] = await db
      .insert(matches)
      .values({
        guildId: 'g1',
        channelId: 'c1',
        gameSlug: 'catan',
        code: 'ABCD',
        joinUrl: 'http://play.example/?join=ABCD',
        callbackToken: 'cb_x',
        createdByDiscordId: 'u1',
        players: 4,
        bots: 0,
        expiresAt: new Date('2026-08-27T12:00:00Z'),
      })
      .returning()
    expect(m!.status).toBe('pending')
    await db.insert(seats).values({ matchId: m!.id, seatToken: 'st_a', discordUserId: 'u1', displayName: 'Ayo' })
    const rows = await db.select().from(seats)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.stats).toBeNull()
  })

  it('rejects duplicate seat tokens', async () => {
    const db = await testDb()
    const [m] = await db
      .insert(matches)
      .values({
        guildId: 'g1', channelId: 'c1', gameSlug: 'catan', code: 'EFGH',
        joinUrl: 'http://play.example/?join=EFGH', callbackToken: 'cb_y',
        createdByDiscordId: 'u1', players: 4, bots: 0,
      })
      .returning()
    await db.insert(seats).values({ matchId: m!.id, seatToken: 'st_dup' })
    await expect(db.insert(seats).values({ matchId: m!.id, seatToken: 'st_dup' })).rejects.toThrow()
  })
})
