import { describe, expect, it } from 'vitest'
import type { Db } from '../src/db/index.js'
import { createHealthCheck } from '../src/health.js'

/** The probe only ever calls `db.execute`, so these tests need no Postgres. */
function fakeDb(execute: () => Promise<unknown>): Db {
  return { execute } as unknown as Db
}
const up = (): Promise<unknown> => Promise.resolve({ rows: [{ '?column?': 1 }] })

function clock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('health check', () => {
  it('reports ok when the database answers and the gateway is connected', async () => {
    const check = createHealthCheck({ db: fakeDb(up), isGatewayReady: () => true, cacheMs: 0 })
    expect(await check()).toEqual({ ok: true, db: 'ok', discord: 'ok' })
  })

  it('fails and names the database when the query rejects', async () => {
    const check = createHealthCheck({ db: fakeDb(() => Promise.reject(new Error('ECONNREFUSED'))), isGatewayReady: () => true, cacheMs: 0 })
    expect(await check()).toEqual({ ok: false, db: 'down', discord: 'ok', detail: 'database down' })
  })

  it('does not hang on a slow database: the probe times out and fails', async () => {
    const check = createHealthCheck({
      db: fakeDb(() => new Promise(() => undefined)), // never settles
      isGatewayReady: () => true,
      timeoutMs: 20,
      cacheMs: 0,
    })
    const report = await check()
    expect(report).toEqual({ ok: false, db: 'timeout', discord: 'ok', detail: 'database timeout' })
  })

  it('treats a brief gateway drop as reconnecting and a sustained one as down', async () => {
    const c = clock()
    let ready = true
    const check = createHealthCheck({
      db: fakeDb(up),
      isGatewayReady: () => ready,
      cacheMs: 0,
      gatewayGraceMs: 60_000,
      now: c.now,
    })
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
      db: fakeDb(up),
      isGatewayReady: () => {
        throw new Error('client not constructed')
      },
      cacheMs: 0,
      gatewayGraceMs: 0,
    })
    expect(await check()).toMatchObject({ ok: false, discord: 'down' })
  })

  it('caches so an unauthenticated /healthz flood cannot become a query flood', async () => {
    const c = clock()
    let queries = 0
    const check = createHealthCheck({
      db: fakeDb(() => {
        queries += 1
        return up()
      }),
      isGatewayReady: () => true,
      cacheMs: 5_000,
      now: c.now,
    })
    await Promise.all(Array.from({ length: 50 }, () => check()))
    for (let i = 0; i < 50; i++) await check()
    expect(queries).toBe(1)
    c.advance(5_001)
    await check()
    expect(queries).toBe(2)
  })
})
