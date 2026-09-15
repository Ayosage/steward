import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import type { Db } from '../src/db/index.js'
import { matches, seats } from '../src/db/schema.js'
import { createHealthCheck, type HealthCheckOptions } from '../src/health.js'
import { createWebhookServer, MAX_BODY_BYTES } from '../src/webhook-server.js'
import { testDb } from './helpers/db.js'

/** Records every query the handler makes, so a test can prove work happened before auth — or did not. */
function countingDb(db: Db): { db: Db; calls: string[] } {
  const calls: string[] = []
  const watched = new Set(['select', 'insert', 'update', 'delete', 'execute', 'transaction'])
  const proxied = new Proxy(db as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value === 'function' && typeof prop === 'string' && watched.has(prop)) {
        return (...args: unknown[]) => {
          calls.push(prop)
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return value
    },
  })
  return { db: proxied as Db, calls }
}

interface RawResult {
  status: number | undefined
  body: string | undefined
  headers: http.IncomingHttpHeaders | undefined
  error: string | undefined
}

/** Raw client so a test can stream a body and see the response that arrives mid-upload. */
function rawPost(base: string, opts: { token?: string; body: Buffer; chunked?: boolean }): Promise<RawResult> {
  const url = new URL('/webhooks/results', base)
  return new Promise((resolve) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (opts.token) headers.authorization = `Bearer ${opts.token}`
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
            error: undefined,
          }),
        )
      },
    )
    req.on('error', (e: NodeJS.ErrnoException) =>
      resolve({ status: undefined, body: undefined, headers: undefined, error: e.code ?? e.message }),
    )
    if (!opts.chunked) return void req.end(opts.body)
    // No content-length: the server has to enforce the cap while the bytes arrive.
    const slice = 64 * 1024
    let at = 0
    const pump = (): void => {
      if (req.destroyed || req.writableEnded) return
      if (at >= opts.body.length) return void req.end()
      req.write(opts.body.subarray(at, at + slice), () => setImmediate(pump))
      at += slice
    }
    pump()
  })
}

let server: http.Server | undefined
afterEach(() => server?.close())

async function setup(
  over: Partial<Parameters<typeof createWebhookServer>[0]> = {},
  health: Partial<HealthCheckOptions> = {},
) {
  const raw = await testDb()
  const [m] = await raw
    .insert(matches)
    .values({
      guildId: 'g1', channelId: 'c1', gameSlug: 'catan', code: 'ABCD',
      joinUrl: 'http://play.example/?join=ABCD', callbackToken: 'cb_good',
      createdByDiscordId: 'u1', players: 3, bots: 0, status: 'active',
    })
    .returning()
  await raw.insert(seats).values({ matchId: m!.id, seatToken: 'st_alice', discordUserId: 'u2', displayName: 'Alice' })
  const onResult = vi.fn<Parameters<typeof createWebhookServer>[0]['onResult']>(async () => undefined)
  // Counting starts after the fixtures are in place, so `calls` only holds handler queries.
  const { db, calls } = countingDb(raw)
  const isGatewayReady = over.isGatewayReady ?? (() => true)
  server = createWebhookServer({
    db,
    onResult,
    isGatewayReady,
    health: createHealthCheck({ db, isGatewayReady, cacheMs: 0, ...health }),
    ...over,
  })
  await new Promise<void>((r) => server!.listen(0, r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { db, onResult, base, calls }
}

function post(base: string, token: string | null, body: string) {
  return fetch(`${base}/webhooks/results`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
  })
}

const GOOD = JSON.stringify({
  code: 'ABCD',
  status: 'completed',
  seats: [{ seatToken: 'st_alice', placement: 1, winner: true, stats: { vp: 10 } }],
})

describe('webhook server', () => {
  it('answers GET /healthz with 200 when the database and gateway are both up', async () => {
    const { base } = await setup()
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, db: 'ok', discord: 'ok' })
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(404)
  })

  it('answers GET /healthz with 503 and names what is down', async () => {
    // Stubbed database: this asserts the wiring from report to status code, not Postgres.
    const down = { execute: () => Promise.reject(new Error('connection refused')) } as unknown as Db
    server = createWebhookServer({
      db: down,
      onResult: async () => undefined,
      isGatewayReady: () => false,
      health: createHealthCheck({ db: down, isGatewayReady: () => false, gatewayGraceMs: 0, cacheMs: 0 }),
    })
    await new Promise<void>((r) => server!.listen(0, r))
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      ok: false,
      db: 'down',
      discord: 'down',
      detail: 'database down; discord gateway down',
    })
  })

  it('persists, returns 200, then fires onResult best-effort', async () => {
    const { onResult, base } = await setup()
    const res = await post(base, 'cb_good', GOOD)
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1))
    const [match, seatRows] = onResult.mock.calls[0]!
    expect(match.status).toBe('completed')
    expect(seatRows).toHaveLength(1)
  })

  it('maps unknown code to 404 and bad token to 401', async () => {
    const { base } = await setup()
    expect((await post(base, 'cb_good', GOOD.replace('ABCD', 'ZZZZ'))).status).toBe(404)
    expect((await post(base, 'cb_evil', GOOD)).status).toBe(401)
    expect((await post(base, null, GOOD)).status).toBe(401)
  })

  it('rejects malformed bodies with 422 and unknown routes with 404', async () => {
    const { base } = await setup()
    expect((await post(base, 'cb_good', 'not json{')).status).toBe(422)
    expect((await post(base, 'cb_good', JSON.stringify({ code: 'ABCD' }))).status).toBe(422)
    expect((await fetch(`${base}/nope`)).status).toBe(404)
  })

  it('rejects an oversized declared body with 413 before any database work', async () => {
    const { base, calls } = await setup()
    const huge = Buffer.alloc(5 * 1024 * 1024, 'a')
    const res = await rawPost(base, { token: 'cb_good', body: huge })
    expect(res.status).toBe(413)
    expect(JSON.parse(res.body!)).toEqual({ error: 'payload too large', limit: MAX_BODY_BYTES })
    expect(calls).toEqual([])
  })

  it('rejects an oversized streamed body with 413 without buffering it first', async () => {
    const { base, calls } = await setup()
    const huge = Buffer.alloc(4 * 1024 * 1024, 'a')
    const res = await rawPost(base, { token: 'cb_good', body: huge, chunked: true })
    expect(res.status).toBe(413)
    // One indexed lookup to authenticate, and nothing else: the body was never parsed.
    expect(calls).toEqual(['select'])
  })

  it('refuses an unknown token before parsing the body at all', async () => {
    const { base, calls } = await setup()
    // Old order parsed first and answered 422; auth now comes first.
    expect((await post(base, 'cb_nope', 'not json{')).status).toBe(401)
    expect(calls).toEqual(['select'])
    const unshaped = await post(base, 'not-a-token', 'not json{')
    expect(unshaped.status).toBe(401)
    expect(calls).toEqual(['select']) // a malformed token never reaches the database
  })

  it('rate limits a burst from one source with 429 and a retry-after', async () => {
    const { base } = await setup()
    const results: number[] = []
    for (let i = 0; i < 40; i++) results.push((await post(base, 'cb_evil', GOOD)).status)
    expect(results.filter((s) => s === 429).length).toBeGreaterThan(0)
    expect(results.slice(0, 30).every((s) => s === 401)).toBe(true)
    const limited = await post(base, 'cb_evil', GOOD)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('answers duplicates with 200 without re-firing onResult', async () => {
    const { onResult, base } = await setup()
    await post(base, 'cb_good', GOOD)
    const res = await post(base, 'cb_good', GOOD)
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1))
  })
})
