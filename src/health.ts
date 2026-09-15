import { sql } from 'drizzle-orm'
import type { Db } from './db/index.js'

export interface HealthReport {
  ok: boolean
  db: 'ok' | 'down' | 'timeout'
  /** `reconnecting` is a gateway blip inside the grace window: reported, but still healthy. */
  discord: 'ok' | 'reconnecting' | 'down'
  /** Names what is broken, for whoever reads the platform log. Absent when everything is up. */
  detail?: string
}

export interface HealthCheckOptions {
  db: Db
  /** True only while the bot is connected to the Discord gateway (`client.isReady()`). */
  isGatewayReady: () => boolean
  /** Bound on the database probe. Fly's check times out at 5s, so stay well under it. */
  timeoutMs?: number
  /** /healthz is public and unauthenticated: reuse a recent answer instead of re-querying. */
  cacheMs?: number
  /** How long the gateway may be disconnected before the check fails. discord.js reconnects on its own. */
  gatewayGraceMs?: number
  now?: () => number
}

/**
 * Returns a probe reporting what Fly's health check actually needs to know: whether
 * the database answers and whether the bot is on the gateway. Either one down means
 * the bot cannot do its job, so the probe fails with 503 and names which.
 */
export function createHealthCheck(opts: HealthCheckOptions): () => Promise<HealthReport> {
  const timeoutMs = opts.timeoutMs ?? 2_000
  const cacheMs = opts.cacheMs ?? 5_000
  const gatewayGraceMs = opts.gatewayGraceMs ?? 60_000
  const now = opts.now ?? Date.now
  let lastReadyAt = now() // startup counts as the first grace window
  let cached: { at: number; report: HealthReport } | undefined
  let inFlight: Promise<HealthReport> | undefined

  const probeDb = async (): Promise<HealthReport['db']> => {
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
        timer.unref?.()
      })
      // A hung query loses the race instead of hanging the check; the pool reclaims it.
      const query = opts.db.execute(sql`select 1`).then(() => 'ok' as const)
      return await Promise.race([query, timeout])
    } catch {
      return 'down'
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const probeGateway = (): HealthReport['discord'] => {
    let ready = false
    try {
      ready = opts.isGatewayReady()
    } catch {
      ready = false
    }
    const t = now()
    if (ready) {
      lastReadyAt = t
      return 'ok'
    }
    return t - lastReadyAt < gatewayGraceMs ? 'reconnecting' : 'down'
  }

  const run = async (): Promise<HealthReport> => {
    const discord = probeGateway()
    const db = await probeDb()
    const detail = [db === 'ok' ? undefined : `database ${db}`, discord === 'down' ? 'discord gateway down' : undefined]
      .filter((d): d is string => d !== undefined)
      .join('; ')
    const report: HealthReport = { ok: db === 'ok' && discord !== 'down', db, discord }
    if (detail) report.detail = detail
    cached = { at: now(), report }
    return report
  }

  return () => {
    if (cached && now() - cached.at < cacheMs) return Promise.resolve(cached.report)
    // Single-flight: a burst of checks shares one probe instead of one query each.
    inFlight ??= run().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }
}
