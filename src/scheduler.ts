import { and, asc, eq, lt, lte } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { gameRoles, matches, scheduledAnnouncements } from './db/schema.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Pending past expiry → expired (nobody joined). Active >24h past expiry → expired
 * (game died without a callback; a late `completed` webhook still wins — see results.ts).
 */
export async function sweepExpiredMatches(db: Db, now: Date = new Date()): Promise<number> {
  const pending = await db
    .update(matches)
    .set({ status: 'expired' })
    .where(and(eq(matches.status, 'pending'), lt(matches.expiresAt, now)))
    .returning({ id: matches.id })
  const stale = await db
    .update(matches)
    .set({ status: 'expired' })
    .where(and(eq(matches.status, 'active'), lt(matches.expiresAt, new Date(now.getTime() - DAY_MS))))
    .returning({ id: matches.id })
  return pending.length + stale.length
}

export interface AnnounceDeps {
  db: Db
  post: (channelId: string, content: string) => Promise<void>
  now?: () => Date
}

export async function fireDueAnnouncements(deps: AnnounceDeps): Promise<number> {
  const now = deps.now?.() ?? new Date()
  const due = await deps.db
    .select()
    .from(scheduledAnnouncements)
    .where(and(eq(scheduledAnnouncements.enabled, true), lte(scheduledAnnouncements.nextRunAt, now)))
  let fired = 0
  for (const a of due) {
    try {
      let content = a.message
      if (a.gameSlug) {
        const [role] = await deps.db
          .select()
          .from(gameRoles)
          .where(and(eq(gameRoles.guildId, a.guildId), eq(gameRoles.gameSlug, a.gameSlug)))
        if (role) content = `<@&${role.roleId}> ${content}`
      }
      await deps.post(a.channelId, content)
      fired++
    } catch (e) {
      console.error(`[gamenight] announcement ${a.id} failed:`, e)
    } finally {
      // Advance even on failure so one bad row can't spam every sweep.
      const next = new Date(a.nextRunAt.getTime())
      while (next.getTime() <= now.getTime()) next.setTime(next.getTime() + a.intervalDays * DAY_MS)
      await deps.db.update(scheduledAnnouncements).set({ nextRunAt: next }).where(eq(scheduledAnnouncements.id, a.id))
    }
  }
  return fired
}

export interface SchedulerOptions {
  /** Upper bound between database reads when nothing is due. Every read wakes Neon for ~5 min. */
  rescanMs?: number
  /** Delay before trying again after a failed tick (database down, mid-suspend, etc.). */
  retryMs?: number
  /** Timer source; tests inject a fake so nothing depends on wall-clock time. */
  timers?: Timers
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref()
    return t
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

export interface SchedulerHandle {
  stop: () => void
  /** Re-read the schedule now; call after an announcement is created or cancelled. */
  wake: () => void
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

/**
 * Wake-on-demand, not a poll: one read learns the earliest `nextRunAt`, one timer sleeps
 * until then, and the expired-match sweep piggybacks on that wake. A 30 s poll kept the
 * Neon compute (5 min autosuspend) awake around the clock and burned the free tier.
 */
export function startScheduler(deps: AnnounceDeps, opts: SchedulerOptions = {}): SchedulerHandle {
  const rescanMs = opts.rescanMs ?? SIX_HOURS_MS
  const retryMs = opts.retryMs ?? 60_000
  const timers = opts.timers ?? realTimers
  let timer: unknown
  let stopped = false
  let running = false
  let wakeRequested = false

  const arm = (delayMs: number): void => {
    if (stopped) return
    timers.clear(timer)
    timer = timers.set(tick, Math.max(0, Math.min(delayMs, rescanMs)))
  }

  const nextDelay = async (): Promise<number> => {
    const now = deps.now?.() ?? new Date()
    const [next] = await deps.db
      .select({ at: scheduledAnnouncements.nextRunAt })
      .from(scheduledAnnouncements)
      .where(eq(scheduledAnnouncements.enabled, true))
      .orderBy(asc(scheduledAnnouncements.nextRunAt))
      .limit(1)
    return next ? next.at.getTime() - now.getTime() : rescanMs
  }

  const tick = (): void => {
    if (stopped || running) return
    running = true
    wakeRequested = false
    void (async () => {
      try {
        await sweepExpiredMatches(deps.db, deps.now?.() ?? new Date())
        await fireDueAnnouncements(deps)
        arm(await nextDelay())
      } catch (e) {
        console.error('[scheduler] tick failed, retrying:', e)
        arm(retryMs)
      } finally {
        running = false
        if (wakeRequested) tick()
      }
    })()
  }

  const wake = (): void => {
    if (stopped) return
    if (running) {
      wakeRequested = true
      return
    }
    arm(0)
  }

  const stop = (): void => {
    stopped = true
    timers.clear(timer)
  }

  active = { stop, wake }
  arm(0)
  return active
}

let active: SchedulerHandle | undefined

/** Nudges the running scheduler from a command default-deps path, if one is running. */
export function wakeScheduler(): void {
  active?.wake()
}
