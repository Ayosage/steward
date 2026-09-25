import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db } from '../src/db/index.js'
import { gameRoles, matches, scheduledAnnouncements } from '../src/db/schema.js'
import { fireDueAnnouncements, startScheduler, sweepExpiredMatches } from '../src/scheduler.js'
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


describe('startScheduler', () => {
  /**
   * A hand-cranked clock: the scheduler's timers land here, and `scheduled()` shows exactly
   * what it armed. Real PGlite underneath, so no global timer faking.
   */
  function fakeClock(start: Date) {
    let now = start.getTime()
    let seq = 0
    const pending = new Map<number, { at: number; fn: () => void }>()
    const timers = {
      set: (fn: () => void, ms: number) => {
        const id = ++seq
        pending.set(id, { at: now + ms, fn })
        return id
      },
      clear: (handle: unknown) => {
        pending.delete(handle as number)
      },
    }
    return {
      timers,
      now: () => new Date(now),
      /** Delays (ms from now) of every armed timer. */
      scheduled: () => [...pending.values()].map((p) => p.at - now),
      /** Move time forward, firing due timers in order and letting each tick finish. */
      async advance(ms: number) {
        const target = now + ms
        for (;;) {
          const due = [...pending.entries()].filter(([, p]) => p.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
          if (!due) break
          now = due[1].at
          pending.delete(due[0])
          due[1].fn()
          await new Promise((r) => setTimeout(r, 50))
        }
        now = target
      },
    }
  }
  const HOUR = 3600_000

  it('arms one timer for the announcement\'s own nextRunAt and fires then, with nothing in between', async () => {
    const db = await testDb()
    await db.insert(scheduledAnnouncements).values({
      guildId: 'g1', channelId: 'c1', gameSlug: null, message: 'Go', nextRunAt: hoursAgo(-2), intervalDays: 7,
    })
    const c = fakeClock(NOW)
    const post = vi.fn(async () => undefined)
    const s = startScheduler({ db, post, now: c.now }, { rescanMs: 6 * HOUR, timers: c.timers })
    await c.advance(0) // startup tick
    await vi.waitFor(() => expect(c.scheduled()).toEqual([2 * HOUR]))
    expect(post).not.toHaveBeenCalled()
    await c.advance(2 * HOUR)
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith('c1', 'Go'))
    s.stop()
  })

  it('with nothing scheduled, arms only the rescan timer', async () => {
    const db = await testDb()
    const c = fakeClock(NOW)
    const s = startScheduler({ db, post: vi.fn(async () => undefined), now: c.now }, { rescanMs: 6 * HOUR, timers: c.timers })
    await c.advance(0)
    await vi.waitFor(() => expect(c.scheduled()).toEqual([6 * HOUR]))
    s.stop()
  })

  it('wake() re-reads so an announcement scheduled after start still fires on time', async () => {
    const db = await testDb()
    const c = fakeClock(NOW)
    const post = vi.fn(async () => undefined)
    const s = startScheduler({ db, post, now: c.now }, { rescanMs: 6 * HOUR, timers: c.timers })
    await c.advance(0)
    await vi.waitFor(() => expect(c.scheduled()).toEqual([6 * HOUR]))
    await db.insert(scheduledAnnouncements).values({
      guildId: 'g1', channelId: 'c1', gameSlug: null, message: 'Late', nextRunAt: hoursAgo(-1), intervalDays: 7,
    })
    s.wake()
    await c.advance(0)
    await vi.waitFor(() => expect(c.scheduled()).toEqual([HOUR]))
    await c.advance(HOUR)
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith('c1', 'Late'))
    s.stop()
  })

  it('sweeps expired matches when it wakes, so the sweep needs no timer of its own', async () => {
    const db = await testDb()
    const stale = await match(db, 'pending', hoursAgo(1))
    const c = fakeClock(NOW)
    const s = startScheduler({ db, post: vi.fn(async () => undefined), now: c.now }, { rescanMs: HOUR, timers: c.timers })
    await c.advance(0)
    await vi.waitFor(async () => {
      const [row] = await db.select().from(matches).where(eq(matches.id, stale.id))
      expect(row!.status).toBe('expired')
    })
    s.stop()
  })

  it('retries after retryMs when the database call fails instead of going silent', async () => {
    const db = await testDb()
    await db.insert(scheduledAnnouncements).values({
      guildId: 'g1', channelId: 'c1', gameSlug: null, message: 'Go', nextRunAt: hoursAgo(1), intervalDays: 7,
    })
    let failing = true
    const flaky = new Proxy(db, {
      get(target, key, receiver) {
        if (failing && (key === 'select' || key === 'update')) {
          return () => {
            throw new Error('connection terminated')
          }
        }
        return Reflect.get(target, key, receiver)
      },
    })
    const c = fakeClock(NOW)
    const post = vi.fn(async () => undefined)
    const s = startScheduler({ db: flaky, post, now: c.now }, { rescanMs: 6 * HOUR, retryMs: 60_000, timers: c.timers })
    await c.advance(0)
    await vi.waitFor(() => expect(c.scheduled()).toEqual([60_000]))
    expect(post).not.toHaveBeenCalled()
    failing = false
    await c.advance(60_000)
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith('c1', 'Go'))
    s.stop()
  })
})
