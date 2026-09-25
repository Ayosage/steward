import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

export type Db = NodePgDatabase<typeof schema>

/** `unknown` until the first query; afterwards the outcome of the most recent one. */
export type DbStatus = 'ok' | 'down' | 'unknown'

interface Queryable {
  query: (...args: unknown[]) => unknown
}

/**
 * Wraps `pool.query` in place so the health check can report the database from queries
 * the bot was already making, instead of sending its own and keeping Neon awake.
 * Callback-style calls pass through untracked; drizzle only uses the promise form.
 */
export function trackQueries(pool: Queryable): () => DbStatus {
  let status: DbStatus = 'unknown'
  const original = pool.query.bind(pool)
  pool.query = (...args: unknown[]): unknown => {
    const result = original(...args)
    if (result instanceof Promise) {
      result.then(
        () => (status = 'ok'),
        () => (status = 'down'),
      )
    }
    return result
  }
  return () => status
}

export interface DbHandle {
  db: Db
  status: () => DbStatus
}

export function createDb(connectionString: string): DbHandle {
  const pool = new pg.Pool({ connectionString })
  const status = trackQueries(pool)
  return { db: drizzle(pool, { schema }), status }
}

let singleton: DbHandle | undefined

function handle(): DbHandle {
  if (!singleton) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set (see .env.example)')
    singleton = createDb(url)
  }
  return singleton
}

/** Process-wide handle for command default-deps. Tests always inject their own. */
export function getDb(): Db {
  return handle().db
}

/** Last observed outcome of a production query; feeds /healthz. */
export function getDbStatus(): DbStatus {
  return handle().status()
}
