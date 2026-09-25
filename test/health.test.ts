import { describe, expect, it } from 'vitest'
import { createHealthCheck } from '../src/health.js'

function clock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('health check', () => {
  it('reports ok when the gateway is connected and the last query succeeded', async () => {
    const check = createHealthCheck({ isGatewayReady: () => true, dbStatus: () => 'ok' })
    expect(await check()).toEqual({ ok: true, db: 'ok', discord: 'ok' })
  })

  it('reports the last observed database failure without probing, and stays routable', async () => {
    // Fly cannot fix Neon by pulling the machine, and a probe here would keep Neon awake
    // forever (5 min autosuspend vs a 30 s check). The field is for whoever reads the log.
    const check = createHealthCheck({ isGatewayReady: () => true, dbStatus: () => 'down' })
    expect(await check()).toEqual({ ok: true, db: 'down', discord: 'ok', detail: 'database down (last query failed)' })
  })

  it('reports unknown before any query has run', async () => {
    const check = createHealthCheck({ isGatewayReady: () => true, dbStatus: () => 'unknown' })
    expect((await check()).db).toBe('unknown')
  })

  it('treats a brief gateway drop as reconnecting and a sustained one as down', async () => {
    const c = clock()
    let ready = true
    const check = createHealthCheck({ isGatewayReady: () => ready, dbStatus: () => 'ok', gatewayGraceMs: 60_000, now: c.now })
    expect((await check()).discord).toBe('ok')
    ready = false
    c.advance(30_000)
    expect(await check()).toMatchObject({ ok: true, discord: 'reconnecting' })
    c.advance(31_000)
    expect(await check()).toMatchObject({ ok: false, discord: 'down', detail: 'discord gateway down' })
    ready = true
    expect((await check()).discord).toBe('ok')
  })

  it('survives a gateway getter that throws', async () => {
    const check = createHealthCheck({
      isGatewayReady: () => {
        throw new Error('client not constructed')
      },
      dbStatus: () => 'ok',
      gatewayGraceMs: 0,
    })
    expect(await check()).toMatchObject({ ok: false, discord: 'down' })
  })
})
