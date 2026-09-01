import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { matches, seats } from './db/schema.js'

export interface GameStats {
  gameSlug: string
  games: number
  wins: number
  winRate: number
}

export interface LeaderRow {
  discordUserId: string
  games: number
  wins: number
  winRate: number
}

const gamesExpr = sql<number>`count(*)`.mapWith(Number)
const winsExpr = sql<number>`count(*) filter (where ${seats.winner})`.mapWith(Number)

/** Derived on the fly from seats ⋈ matches; only completed matches count. */
export async function playerStats(db: Db, guildId: string, discordUserId: string, gameSlug?: string): Promise<GameStats[]> {
  const filters = [
    eq(matches.guildId, guildId),
    eq(matches.status, 'completed'),
    eq(seats.discordUserId, discordUserId),
  ]
  if (gameSlug) filters.push(eq(matches.gameSlug, gameSlug))
  const rows = await db
    .select({ gameSlug: matches.gameSlug, games: gamesExpr, wins: winsExpr })
    .from(seats)
    .innerJoin(matches, eq(seats.matchId, matches.id))
    .where(and(...filters))
    .groupBy(matches.gameSlug)
  return rows.map((r) => ({ ...r, winRate: r.games > 0 ? r.wins / r.games : 0 }))
}

export async function leaderboard(db: Db, guildId: string, gameSlug: string, limit = 10): Promise<LeaderRow[]> {
  const winRateExpr = sql`(count(*) filter (where ${seats.winner}))::float / count(*)`
  const rows = await db
    .select({ discordUserId: seats.discordUserId, games: gamesExpr, wins: winsExpr })
    .from(seats)
    .innerJoin(matches, eq(seats.matchId, matches.id))
    .where(
      and(
        eq(matches.guildId, guildId),
        eq(matches.status, 'completed'),
        eq(matches.gameSlug, gameSlug),
        isNotNull(seats.discordUserId),
      ),
    )
    .groupBy(seats.discordUserId)
    .orderBy(desc(winsExpr), desc(winRateExpr))
    .limit(limit)
  return rows.map((r) => ({
    discordUserId: r.discordUserId!,
    games: r.games,
    wins: r.wins,
    winRate: r.games > 0 ? r.wins / r.games : 0,
  }))
}
