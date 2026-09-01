import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

export type Db = NodePgDatabase<typeof schema>

export function createDb(connectionString: string): Db {
  return drizzle(new pg.Pool({ connectionString }), { schema })
}

let singleton: Db | undefined

/** Process-wide handle for command default-deps. Tests always inject their own. */
export function getDb(): Db {
  if (!singleton) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set (see .env.example)')
    singleton = createDb(url)
  }
  return singleton
}
