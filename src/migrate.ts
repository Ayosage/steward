import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

/**
 * Applies pending SQL migrations from ./drizzle using drizzle-orm's built-in migrator.
 * Runs at container start (see docker-entrypoint.sh) so production never needs drizzle-kit.
 * Resolves the folder relative to this file so it works from both src/ (tsx) and dist/ (node).
 */
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set (see .env.example)')
  process.exit(1)
}

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
const pool = new pg.Pool({ connectionString: url })
try {
  await migrate(drizzle(pool), { migrationsFolder })
  console.log(`migrations applied (${migrationsFolder})`)
} finally {
  await pool.end()
}
