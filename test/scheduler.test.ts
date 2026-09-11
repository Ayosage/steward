import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db } from '../src/db/index.js'
import { gameRoles, matches, scheduledAnnouncements } from '../src/db/schema.js'
import { fireDueAnnouncements, sweepExpiredMatches,  } from '../src/scheduler.js'
import { testDb } from './helpers/db.js'

const NOW = new Date('2026-08-27T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000)

async function match(db: Db, status: 'pending' | 'active' | 'completed', expiresAt: Date) {
  const [m] = await db
    .insert(matches)
    .values({
      guildId: 'g1', channelId: 'c1', gameSlug: 'catan', code: `C${Math.floor(Math.random() * 1e6)}`,
      joinUrl: 'http://p.example/?join=X', callbackToken: `cb_${Math.random()}`,
      createdByDiscordId: 'u1', players: 4, bots: 0, status, expiresAt,
    })
    .returning()
  return m!
}

describe('sweepExpiredMatches', () => {
  it('expires pending matches past expiry and long-stale active matches, leaves the rest', async () => {
    const db = await testDb()
    const stalePending = await match(db, 'pending', hoursAgo(1))
    const freshPending = await match(db, 'pending', hoursAgo(-1))
    const staleActive = await match(db, 'active', hoursAgo(25))
    const runningActive = await match(db, 'active', hoursAgo(2))
    const done = await match(db, 'completed', hoursAgo(30))
    expect(await sweepExpiredMatches(db, NOW)).toBe(2)
    const byId = async (id: number) => (await db.select().from(matches).where(eq(matches.id, id)))[0]!.status
    expect(await byId(stalePending.id)).toBe('expired')
    expect(await byId(freshPending.id)).toBe('pending')
    expect(await byId(staleActive.id)).toBe('expired')
    expect(await byId(runningActive.id)).toBe('active')
    expect(await byId(done.id)).toBe('completed')
  })
})

describe('fireDueAnnouncements', () => {
  it('posts due announcements with the game role ping and advances nextRunAt past now', async () => {
    const db = await testDb()
    await db.insert(gameRoles).values({ guildId: 'g1', gameSlug: 'catan', roleId: 'r1' })
    const [a] = await db
      .insert(scheduledAnnouncements)
      .values({ guildId: 'g1', channelId: 'c1', gameSlug: 'catan', message: 'Game night!', nextRunAt: hoursAgo(1), intervalDays: 7 })
      .returning()
    const post = vi.fn(async () => undefined)
    expect(await fireDueAnnouncements({ db, post, now: () => NOW })).toBe(1)
    expect(post).toHaveBeenCalledWith('c1', '<@&r1> Game night!')
    const [after] = await db.select().from(scheduledAnnouncements).where(eq(scheduledAnnouncements.id, a!.id))
    expect(after!.nextRunAt.getTime()).toBeGreaterThan(NOW.getTime())
    // second sweep: nothing due
    expect(await fireDueAnnouncements({ db, post, now: () => NOW })).toBe(0)
  })

  it('a failing post still advances the row so one bad channel cannot spam or stall', async () => {
    const db = await testDb()
    await db.insert(scheduledAnnouncements).values({
      guildId: 'g1', channelId: 'c-dead', gameSlug: null, message: 'Hi', nextRunAt: hoursAgo(1), intervalDays: 1,
    })
    const post = vi.fn(async () => {
      throw new Error('Unknown Channel')
    })
    expect(await fireDueAnnouncements({ db, post, now: () => NOW })).toBe(0)
    const rows = await db.select().from(scheduledAnnouncements)
    expect(rows[0]!.nextRunAt.getTime()).toBeGreaterThan(NOW.getTime())
  })

  it('ignores disabled announcements', async () => {
    const db = await testDb()
    await db.insert(scheduledAnnouncements).values({
      guildId: 'g1', channelId: 'c1', gameSlug: null, message: 'Hi', nextRunAt: hoursAgo(1), intervalDays: 1, enabled: false,
    })
    const post = vi.fn(async () => undefined)
    expect(await fireDueAnnouncements({ db, post, now: () => NOW })).toBe(0)
  })
})

