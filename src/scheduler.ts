import { and, eq, lt, lte } from 'drizzle-orm'
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

/** Poll loop; each job is isolated so one bad row can't stall the rest. Returns a stop function. */
export function startScheduler(deps: AnnounceDeps, intervalMs = 30_000): () => void {
  const tick = (): void => {
    sweepExpiredMatches(deps.db).catch((e) => console.error('[sweep] failed:', e))
    fireDueAnnouncements(deps).catch((e) => console.error('[gamenight] sweep failed:', e))
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
