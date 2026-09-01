import { and, eq, notInArray } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from './db/index.js'
import { matches, seats, type MatchRow, type SeatRow } from './db/schema.js'
import { newToken } from './tokens.js'

export const resultSchema = z.object({
  code: z.string().min(1),
  status: z.enum(['completed', 'abandoned']),
  seats: z.array(
    z.object({
      seatToken: z.string().optional(),
      displayName: z.string().optional(),
      placement: z.number().int().positive().optional(),
      winner: z.boolean().optional(),
      stats: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
})

export type ResultReport = z.infer<typeof resultSchema>

export type ProcessOutcome =
  | { kind: 'ok'; match: MatchRow; seats: SeatRow[] }
  | { kind: 'duplicate' }
  | { kind: 'unknown' }
  | { kind: 'unauthorized' }

export async function processResult(db: Db, bearerToken: string, report: ResultReport): Promise<ProcessOutcome> {
  const candidates = await db.select().from(matches).where(eq(matches.code, report.code))
  if (candidates.length === 0) return { kind: 'unknown' }
  const match = candidates.find((m) => m.callbackToken === bearerToken)
  if (!match) return { kind: 'unauthorized' }

  // First transition to a final status wins; guarded update makes replays no-ops.
  // A late `completed` still wins over `expired` — the game is the source of truth.
  const [finalized] = await db
    .update(matches)
    .set({ status: report.status, finishedAt: new Date() })
    .where(and(eq(matches.id, match.id), notInArray(matches.status, ['completed', 'abandoned'])))
    .returning()
  if (!finalized) return { kind: 'duplicate' }

  for (const s of report.seats) {
    if (s.seatToken) {
      const updated = await db
        .update(seats)
        .set({
          ...(s.displayName !== undefined ? { displayName: s.displayName } : {}),
          placement: s.placement ?? null,
          winner: s.winner ?? false,
          stats: s.stats ?? null,
        })
        .where(and(eq(seats.matchId, match.id), eq(seats.seatToken, s.seatToken)))
        .returning()
      if (updated.length > 0) continue
      // A token Steward never minted for this match: store the seat, but anonymously.
    }
    await db.insert(seats).values({
      matchId: match.id,
      seatToken: newToken('st'),
      discordUserId: null,
      displayName: s.displayName ?? null,
      placement: s.placement ?? null,
      winner: s.winner ?? false,
      stats: s.stats ?? null,
    })
  }

  const allSeats = await db.select().from(seats).where(eq(seats.matchId, match.id))
  return { kind: 'ok', match: finalized, seats: allSeats }
}
