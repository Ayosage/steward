import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db } from '../src/db/index.js'
import { matches, type MatchRow } from '../src/db/schema.js'
import { MatchClosedError, MatchFullError, mintSeat, personalJoinUrl } from '../src/matches.js'
import { testDb } from './helpers/db.js'

async function seedMatch(db: Db, overrides: Partial<typeof matches.$inferInsert> = {}): Promise<MatchRow> {
  const [m] = await db
    .insert(matches)
    .values({
      guildId: 'g1', channelId: 'c1', gameSlug: 'catan', code: 'ABCD',
      joinUrl: 'http://play.example/?join=ABCD', callbackToken: `cb_${Math.random()}`,
      createdByDiscordId: 'u1', players: 3, bots: 1,
      ...overrides,
    })
    .returning()
  return m!
}

describe('personalJoinUrl', () => {
  it('appends the seat token to an URL that already has a query', () => {
    expect(personalJoinUrl('http://play.example/?join=ABCD', 'st_x')).toBe('http://play.example/?join=ABCD&seat=st_x')
  })
})

describe('mintSeat', () => {
  it('mints a seat bound to the discord user and activates a pending match', async () => {
    const db = await testDb()
    const m = await seedMatch(db)
    const minted = await mintSeat(db, m, { id: 'u2', displayName: 'Alice' })
    expect(minted.reused).toBe(false)
    expect(minted.seat.seatToken).toMatch(/^st_/)
    expect(minted.seat.discordUserId).toBe('u2')
    expect(minted.personalUrl).toContain(`seat=${minted.seat.seatToken}`)
    const [after] = await db.select().from(matches).where(eq(matches.id, m.id))
    expect(after!.status).toBe('active')
  })

  it('returns the same link on a second click, not a second seat', async () => {
    const db = await testDb()
    const m = await seedMatch(db)
    const first = await mintSeat(db, m, { id: 'u2', displayName: 'Alice' })
    const second = await mintSeat(db, m, { id: 'u2', displayName: 'Alice' })
    expect(second.reused).toBe(true)
    expect(second.seat.seatToken).toBe(first.seat.seatToken)
  })

  it('rejects when all human seats are taken (players - bots)', async () => {
    const db = await testDb()
    const m = await seedMatch(db) // 3 players, 1 bot → 2 human seats
    await mintSeat(db, m, { id: 'u2', displayName: 'Alice' })
    await mintSeat(db, m, { id: 'u3', displayName: 'Bob' })
    await expect(mintSeat(db, m, { id: 'u4', displayName: 'Cara' })).rejects.toThrow(MatchFullError)
  })

  it('rejects joins on a closed match', async () => {
    const db = await testDb()
    const m = await seedMatch(db, { status: 'expired' })
    await expect(mintSeat(db, m, { id: 'u2', displayName: 'Alice' })).rejects.toThrow(MatchClosedError)
  })
})

describe('mintSeat expiry at read time', () => {
  const NOW = new Date('2026-08-27T12:00:00Z')
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000)

  it('refuses a pending match past its expiry even before any sweep has run', async () => {
    const db = await testDb()
    const m = await seedMatch(db, { expiresAt: hoursAgo(1) })
    await expect(mintSeat(db, m, { id: 'u2', displayName: 'Alice' }, NOW)).rejects.toBeInstanceOf(MatchClosedError)
  })

  it('still seats an active match inside the 24h grace the sweep allows', async () => {
    const db = await testDb()
    const m = await seedMatch(db, { status: 'active', expiresAt: hoursAgo(2) })
    const minted = await mintSeat(db, m, { id: 'u2', displayName: 'Alice' }, NOW)
    expect(minted.reused).toBe(false)
  })

  it('refuses an active match more than 24h past expiry', async () => {
    const db = await testDb()
    const m = await seedMatch(db, { status: 'active', expiresAt: hoursAgo(25) })
    await expect(mintSeat(db, m, { id: 'u2', displayName: 'Alice' }, NOW)).rejects.toBeInstanceOf(MatchClosedError)
  })
})
