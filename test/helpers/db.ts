import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { Db } from '../../src/db/index.js'
import * as schema from '../../src/db/schema.js'

/** Fresh in-process Postgres with migrations applied. One per test (or per file). */
export async function testDb(): Promise<Db> {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: 'drizzle' })
  // PgliteDatabase and NodePgDatabase share the query API; services only see `Db`.
  return db as unknown as Db
}
