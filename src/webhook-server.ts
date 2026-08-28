import http from 'node:http'
import type { Db } from './db/index.js'
import type { MatchRow, SeatRow } from './db/schema.js'
import { processResult, resultSchema } from './results.js'

export interface WebhookDeps {
  db: Db
  /** Best-effort embed posting — runs after the 2xx; a Discord outage never makes the game retry. */
  onResult: (match: MatchRow, seats: SeatRow[]) => Promise<void>
}

export function createWebhookServer(deps: WebhookDeps): http.Server {
  return http.createServer((req, res) => {
    handle(req, res, deps).catch((e) => {
      console.error('[webhook] handler crashed:', e)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal error' }))
      }
    })
  })
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: WebhookDeps): Promise<void> {
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'POST' || req.url !== '/webhooks/results') return send(404, { error: 'not found' })
  const auth = req.headers.authorization ?? ''
  if (!auth.startsWith('Bearer ')) return send(401, { error: 'missing bearer token' })
  const token = auth.slice('Bearer '.length)

  let raw: string
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    raw = Buffer.concat(chunks).toString('utf8')
  } catch {
    return send(422, { error: 'unreadable body' })
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
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
