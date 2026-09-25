import type { DbStatus } from './db/index.js'

export interface HealthReport {
  ok: boolean
  /** Outcome of the most recent real query. Never probed: see `createHealthCheck`. */
  db: DbStatus
  /** `reconnecting` is a gateway blip inside the grace window: reported, but still healthy. */
  discord: 'ok' | 'reconnecting' | 'down'
  /** Names what is broken, for whoever reads the platform log. Absent when everything is up. */
  detail?: string
}

export interface HealthCheckOptions {
  /** True only while the bot is connected to the Discord gateway (`client.isReady()`). */
  isGatewayReady: () => boolean
  /** Last observed query outcome, from `trackQueries`. Read, never queried. */
  dbStatus: () => DbStatus
  /** How long the gateway may be disconnected before the check fails. discord.js reconnects on its own. */
  gatewayGraceMs?: number
  now?: () => number
}

/**
 * Returns a probe for Fly's health check. `ok` follows the gateway alone: a bot off the
 * gateway cannot do its job and a fresh machine may fix that. The database is reported
 * but does not fail the check. Fly cannot fix Neon by pulling the machine, a stale
 * failure would stop routing result webhooks, and probing it from a 30 s check kept the
 * Neon compute (5 min autosuspend) awake around the clock.
 */
export function createHealthCheck(opts: HealthCheckOptions): () => Promise<HealthReport> {
  const gatewayGraceMs = opts.gatewayGraceMs ?? 60_000
  const now = opts.now ?? Date.now
  let lastReadyAt = now() // startup counts as the first grace window

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

  return () => {
    const discord = probeGateway()
    const db = opts.dbStatus()
    const detail = [db === 'down' ? 'database down (last query failed)' : undefined, discord === 'down' ? 'discord gateway down' : undefined]
      .filter((d): d is string => d !== undefined)
      .join('; ')
    const report: HealthReport = { ok: discord !== 'down', db, discord }
    if (detail) report.detail = detail
    return Promise.resolve(report)
  }
}
