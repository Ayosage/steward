import http from 'node:http'
import { eq } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { matches, type MatchRow, type SeatRow } from './db/schema.js'
import { createHealthCheck, type HealthReport } from './health.js'
import { createRateLimiter, type RateLimiter } from './rate-limit.js'
import { processResult, resultSchema } from './results.js'

/** A real result report is a few hundred bytes; 64 KiB leaves room for fat stats blobs. */
export const MAX_BODY_BYTES = 64 * 1024

/** Shape of a token minted by `newToken('cb')`. Cheap screen before any database work. */
const CALLBACK_TOKEN = /^cb_[A-Za-z0-9_-]{1,128}$/

/**
 * After an early rejection the rest of the upload is read and thrown away rather than
 * buffered, so the caller can still read the response instead of getting a reset socket
 * (nginx calls this a lingering close). Nothing is retained; these two budgets bound how
 * long a rejected caller may keep talking.
 */
const LINGER_MS = 1_000
const LINGER_BYTES = 16 * 1024 * 1024

export interface WebhookDeps {
  db: Db
  /** Best-effort embed posting — runs after the 2xx; a Discord outage never makes the game retry. */
  onResult: (match: MatchRow, seats: SeatRow[]) => Promise<void>
  /** True only while the bot is connected to the Discord gateway. */
  isGatewayReady: () => boolean
  /** Overrides for tests; production uses the defaults. */
  rateLimit?: RateLimiter
  health?: () => Promise<HealthReport>
  maxBodyBytes?: number
}

export function createWebhookServer(deps: WebhookDeps): http.Server {
  // 30 requests/minute per source with a burst of 30. A real game server posts one
  // result per match; anything near this ceiling is abuse. In-process is enough:
  // see the note in rate-limit.ts.
  const rateLimit = deps.rateLimit ?? createRateLimiter({ capacity: 30, refillPerMinute: 30 })
  const health = deps.health ?? createHealthCheck({ db: deps.db, isGatewayReady: deps.isGatewayReady })
  const maxBodyBytes = deps.maxBodyBytes ?? MAX_BODY_BYTES
  return http.createServer((req, res) => {
    handle(req, res, { deps, rateLimit, health, maxBodyBytes }).catch((e) => {
      console.error('[webhook] handler crashed:', e)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal error' }))
      }
    })
  })
}

interface Ctx {
  deps: WebhookDeps
  rateLimit: RateLimiter
  health: () => Promise<HealthReport>
  maxBodyBytes: number
}

/**
 * `fly-client-ip` is set by the Fly proxy, which is the only path to this port in
 * production (`http_service`, no public machine IP). Locally there is no proxy, so
 * fall back to the socket. `x-forwarded-for` is deliberately not trusted: any client
 * can send it, and trusting it would let one attacker spend every bucket in the map.
 */
function clientKey(req: http.IncomingMessage): string {
  const fly = req.headers['fly-client-ip']
  const header = Array.isArray(fly) ? fly[0] : fly
  return header?.trim() || req.socket.remoteAddress || 'unknown'
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx): Promise<void> {
  const { deps } = ctx
  const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  /** Answer now; discard whatever is still being uploaded instead of buffering it. */
  const reject = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
    send(status, body, headers)
    lingerClose(req)
  }

  if (req.method === 'GET' && req.url === '/healthz') {
    const report = await ctx.health()
    return send(report.ok ? 200 : 503, report)
  }
  if (req.method !== 'POST' || req.url !== '/webhooks/results') return send(404, { error: 'not found' })

  const verdict = ctx.rateLimit.take(clientKey(req))
  if (!verdict.allowed) return reject(429, { error: 'too many requests' }, { 'retry-after': String(verdict.retryAfter) })

  const auth = req.headers.authorization ?? ''
  if (!auth.startsWith('Bearer ')) return reject(401, { error: 'missing bearer token' })
  const token = auth.slice('Bearer '.length)
  if (!CALLBACK_TOKEN.test(token)) return reject(401, { error: 'bad callback token' })

  // Declared oversize never gets read at all.
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > ctx.maxBodyBytes) {
    return reject(413, { error: 'payload too large', limit: ctx.maxBodyBytes })
  }

  // Authenticate before parsing or touching match data: an anonymous caller costs
  // one indexed lookup on the unique callback_token, and never a JSON parse.
  const [known] = await deps.db
    .select({ id: matches.id })
    .from(matches)
    .where(eq(matches.callbackToken, token))
    .limit(1)
  if (!known) return reject(401, { error: 'bad callback token' })

  const body = await readBody(req, ctx.maxBodyBytes)
  if (!body.ok) {
    if (body.reason === 'too-large') return reject(413, { error: 'payload too large', limit: ctx.maxBodyBytes })
    return send(422, { error: 'unreadable body' })
  }
  let json: unknown
  try {
    json = JSON.parse(body.raw)
  } catch {
    return send(422, { error: 'malformed JSON' })
  }
  const parsed = resultSchema.safeParse(json)
  if (!parsed.success) return send(422, { error: 'invalid result payload' })

  const outcome = await processResult(deps.db, token, parsed.data)
  switch (outcome.kind) {
    case 'unknown':
      return send(404, { error: 'unknown match code' })
    case 'unauthorized':
      return send(401, { error: 'bad callback token' })
    case 'duplicate':
      return send(200, { ok: true, duplicate: true })
    case 'ok':
      send(200, { ok: true })
      deps.onResult(outcome.match, outcome.seats).catch((e) => console.error('[webhook] result posting failed:', e))
  }
}

/** Drain and discard the rest of a request under a time and byte budget, then hang up. */
function lingerClose(req: http.IncomingMessage): void {
  if (req.readableEnded || req.destroyed) return
  let discarded = 0
  const timer = setTimeout(() => req.destroy(), LINGER_MS)
  timer.unref?.()
  const stop = (): void => clearTimeout(timer)
  req.on('data', (chunk: Buffer) => {
    discarded += chunk.length
    if (discarded > LINGER_BYTES) {
      stop()
      req.destroy()
    }
  })
  req.on('end', stop)
  req.on('error', stop)
  req.on('close', stop)
  req.resume()
}

type BodyResult = { ok: true; raw: string } | { ok: false; reason: 'too-large' | 'unreadable' }

/** Buffers up to `limit` bytes and stops there — the cap is applied per chunk, not after the fact. */
function readBody(req: http.IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const done = (result: BodyResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > limit) return done({ ok: false, reason: 'too-large' })
      chunks.push(chunk)
    })
    req.on('end', () => done({ ok: true, raw: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', () => done({ ok: false, reason: 'unreadable' }))
    req.on('close', () => done({ ok: false, reason: 'unreadable' }))
  })
}
