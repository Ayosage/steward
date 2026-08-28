import { and, eq } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { matches, seats, type MatchRow, type SeatRow } from './db/schema.js'
import { createGameMatch } from './game-client.js'
import type { GameDef } from './games.js'
import { newToken } from './tokens.js'

export interface LaunchMatchArgs {
  db: Db
  game: GameDef
  players: number
  bots: number
  guildId: string
  channelId: string
  createdByDiscordId: string
  publicBaseUrl: string
  createMatch?: typeof createGameMatch
}

/** Launch via the game adapter; the match row exists only after the game's 201. */
export async function launchMatch(args: LaunchMatchArgs): Promise<MatchRow> {
  const create = args.createMatch ?? createGameMatch
  const callbackToken = newToken('cb')
  const launched = await create(args.game, {
    players: args.players,
    bots: args.bots,
    callback: { url: `${args.publicBaseUrl}/webhooks/results`, token: callbackToken },
  })
  const [row] = await args.db
    .insert(matches)
    .values({
      guildId: args.guildId,
      channelId: args.channelId,
      gameSlug: args.game.slug,
      code: launched.code,
      joinUrl: launched.joinUrl,
      callbackToken,
      createdByDiscordId: args.createdByDiscordId,
      players: args.players,
      bots: args.bots,
      expiresAt: new Date(launched.expiresAt),
    })
    .returning()
  return row!
}

export class MatchClosedError extends Error {}
export class MatchFullError extends Error {}

/** joinUrl + `&seat=<token>` — tokens are opaque to the game; it binds token → seat. */
export function personalJoinUrl(joinUrl: string, seatToken: string): string {
  const u = new URL(joinUrl)
  u.searchParams.set('seat', seatToken)
  return u.toString()
}

export interface MintedSeat {
  seat: SeatRow
  personalUrl: string
  reused: boolean
}

export async function mintSeat(
  db: Db,
  match: MatchRow,
  user: { id: string; displayName: string },
): Promise<MintedSeat> {
  if (match.status !== 'pending' && match.status !== 'active') throw new MatchClosedError('match is closed')
  const [existing] = await db
    .select()
    .from(seats)
    .where(and(eq(seats.matchId, match.id), eq(seats.discordUserId, user.id)))
  if (existing) return { seat: existing, personalUrl: personalJoinUrl(match.joinUrl, existing.seatToken), reused: true }
  const taken = await db.select().from(seats).where(eq(seats.matchId, match.id))
  if (taken.length >= match.players - match.bots) throw new MatchFullError('all seats are taken')
  const [seat] = await db
    .insert(seats)
    .values({
      matchId: match.id,
      seatToken: newToken('st'),
      discordUserId: user.id,
      displayName: user.displayName,
    })
    .returning()
  if (match.status === 'pending') await db.update(matches).set({ status: 'active' }).where(eq(matches.id, match.id))
  return { seat: seat!, personalUrl: personalJoinUrl(match.joinUrl, seat!.seatToken), reused: false }
}
