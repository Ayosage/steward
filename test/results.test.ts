import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db } from '../src/db/index.js'
import { matches, seats } from '../src/db/schema.js'
import { processResult, resultSchema } from '../src/results.js'
import { testDb } from './helpers/db.js'

async function seed(db: Db, status: 'pending' | 'active' | 'expired' = 'active') {
  const [m] = await db
    .insert(matches)
    .values({
      guildId: 'g1', channelId: 'c1', gameSlug: 'catan', code: 'ABCD',
      joinUrl: 'http://play.example/?join=ABCD', callbackToken: 'cb_good',
      createdByDiscordId: 'u1', players: 3, bots: 1, status,
    })
    .returning()
  await db.insert(seats).values([
    { matchId: m!.id, seatToken: 'st_alice', discordUserId: 'u2', displayName: 'Alice' },
    { matchId: m!.id, seatToken: 'st_bob', discordUserId: 'u3', displayName: 'Bob' },
  ])
  return m!
}

const REPORT = resultSchema.parse({
  code: 'ABCD',
  status: 'completed',
  seats: [
    { seatToken: 'st_alice', displayName: 'Alice', placement: 1, winner: true, stats: { vp: 10, longestRoad: true } },
    { seatToken: 'st_bob', displayName: 'Bob', placement: 2, winner: false, stats: { vp: 7 } },
    { displayName: 'RandoBot', placement: 3, winner: false },
  ],
})

describe('processResult', () => {
  it('completes the match, upserts tokened seats, inserts anonymous seats', async () => {
    const db = await testDb()
    const m = await seed(db)
    const out = await processResult(db, 'cb_good', REPORT)
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.match.status).toBe('completed')
    expect(out.match.finishedAt).not.toBeNull()
    expect(out.seats).toHaveLength(3)
    const alice = out.seats.find((s) => s.seatToken === 'st_alice')!
    expect(alice.winner).toBe(true)
    expect(alice.discordUserId).toBe('u2')
    expect(alice.stats).toEqual({ vp: 10, longestRoad: true })
    const anon = out.seats.find((s) => s.displayName === 'RandoBot')!
    expect(anon.discordUserId).toBeNull()
  })

  it('is idempotent: a second delivery is a duplicate no-op', async () => {
    const db = await testDb()
    await seed(db)
    await processResult(db, 'cb_good', REPORT)
    const again = await processResult(db, 'cb_good', REPORT)
    expect(again.kind).toBe('duplicate')
    expect(await db.select().from(seats)).toHaveLength(3) // no re-inserted anon seats
  })

  it("a late completed webhook wins over the sweep's expired guess", async () => {
    const db = await testDb()
    const m = await seed(db, 'expired')
    const out = await processResult(db, 'cb_good', REPORT)
    expect(out.kind).toBe('ok')
    const [after] = await db.select().from(matches).where(eq(matches.id, m.id))
    expect(after!.status).toBe('completed')
  })

  it('rejects unknown codes and bad tokens distinctly', async () => {
    const db = await testDb()
    await seed(db)
    expect((await processResult(db, 'cb_good', { ...REPORT, code: 'ZZZZ' })).kind).toBe('unknown')
    expect((await processResult(db, 'cb_evil', REPORT)).kind).toBe('unauthorized')
  })
})
