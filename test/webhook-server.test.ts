import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { matches, seats } from '../src/db/schema.js'
import { createWebhookServer } from '../src/webhook-server.js'
import { testDb } from './helpers/db.js'

let server: http.Server | undefined
afterEach(() => server?.close())

async function setup() {
  const db = await testDb()
  const [m] = await db
    .insert(matches)
    .values({
      guildId: 'g1', channelId: 'c1', gameSlug: 'catan', code: 'ABCD',
      joinUrl: 'http://play.example/?join=ABCD', callbackToken: 'cb_good',
      createdByDiscordId: 'u1', players: 3, bots: 0, status: 'active',
    })
    .returning()
  await db.insert(seats).values({ matchId: m!.id, seatToken: 'st_alice', discordUserId: 'u2', displayName: 'Alice' })
  const onResult = vi.fn<Parameters<typeof createWebhookServer>[0]['onResult']>(async () => undefined)
  server = createWebhookServer({ db, onResult })
  await new Promise<void>((r) => server!.listen(0, r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { db, onResult, base }
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
  it('answers GET /healthz with 200 for platform health checks', async () => {
    const { base } = await setup()
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(404)
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

  it('answers duplicates with 200 without re-firing onResult', async () => {
    const { onResult, base } = await setup()
    await post(base, 'cb_good', GOOD)
    const res = await post(base, 'cb_good', GOOD)
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1))
  })
})
