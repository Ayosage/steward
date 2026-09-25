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
  /** The invoker. Their seat is minted before the launch so the game can reserve seat 0 for it. */
  host: { id: string; displayName: string }
  publicBaseUrl: string
  createMatch?: typeof createGameMatch
}

export interface LaunchedMatch {
  match: MatchRow
  hostSeat: SeatRow
  /** The host's personal join link (joinUrl + their seat token). */
  personalUrl: string
}

/** Launch via the game adapter; the match and host-seat rows exist only after the game's 201. */
export async function launchMatch(args: LaunchMatchArgs): Promise<LaunchedMatch> {
  const create = args.createMatch ?? createGameMatch
  const callbackToken = newToken('cb')
  const hostSeatToken = newToken('st')
  const launched = await create(args.game, {
    players: args.players,
    bots: args.bots,
    callback: { url: `${args.publicBaseUrl}/webhooks/results`, token: callbackToken },
    host: { seatToken: hostSeatToken, displayName: args.host.displayName },
  })
  return args.db.transaction(async (tx) => {
    const [match] = await tx
      .insert(matches)
      .values({
        guildId: args.guildId,
        channelId: args.channelId,
        gameSlug: args.game.slug,
        code: launched.code,
        joinUrl: launched.joinUrl,
        callbackToken,
        createdByDiscordId: args.host.id,
        players: args.players,
        bots: args.bots,
        expiresAt: new Date(launched.expiresAt),
      })
      .returning()
    const [hostSeat] = await tx
      .insert(seats)
      .values({
        matchId: match!.id,
        seatToken: hostSeatToken,
        discordUserId: args.host.id,
        displayName: args.host.displayName,
      })
      .returning()
    return { match: match!, hostSeat: hostSeat!, personalUrl: personalJoinUrl(match!.joinUrl, hostSeatToken) }
  })
}

export class MatchClosedError extends Error {}
export class MatchFullError extends Error {}

/** joinUrl + `&seat=<token>` — tokens are opaque to the game; it binds token → seat. */
export function personalJoinUrl(joinUrl: string, seatToken: string): string {
  const u = new URL(joinUrl)
  u.searchParams.set('seat', seatToken)
  return u.toString()
}

const ACTIVE_GRACE_MS = 24 * 60 * 60 * 1000

/** Same rule the sweep applies: pending dies at expiry, active gets 24h for a late webhook. */
export function isExpired(match: Pick<MatchRow, 'status' | 'expiresAt'>, now: Date): boolean {
  if (!match.expiresAt) return false
  if (match.status === 'pending') return match.expiresAt.getTime() < now.getTime()
  if (match.status === 'active') return match.expiresAt.getTime() + ACTIVE_GRACE_MS < now.getTime()
  return false
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
  now: Date = new Date(),
): Promise<MintedSeat> {
  if (match.status !== 'pending' && match.status !== 'active') throw new MatchClosedError('match is closed')
  // Expiry is judged here, not left to the sweep: the sweep now runs only when the
  // scheduler wakes, so a row can sit past its expiry for hours with status unchanged.
  if (isExpired(match, now)) throw new MatchClosedError('match is closed')
  // Row-lock the match so concurrent Join clicks serialize; the partial unique
  // index on (match_id, discord_user_id) backstops the reuse check.
  return db.transaction(async (tx) => {
    await tx.select({ id: matches.id }).from(matches).where(eq(matches.id, match.id)).for('update')
    const [existing] = await tx
      .select()
      .from(seats)
      .where(and(eq(seats.matchId, match.id), eq(seats.discordUserId, user.id)))
    if (existing) return { seat: existing, personalUrl: personalJoinUrl(match.joinUrl, existing.seatToken), reused: true }
    const taken = await tx.select().from(seats).where(eq(seats.matchId, match.id))
    if (taken.length >= match.players - match.bots) throw new MatchFullError('all seats are taken')
    const [seat] = await tx
      .insert(seats)
      .values({
        matchId: match.id,
        seatToken: newToken('st'),
        discordUserId: user.id,
        displayName: user.displayName,
      })
      .returning()
    if (match.status === 'pending') await tx.update(matches).set({ status: 'active' }).where(eq(matches.id, match.id))
    return { seat: seat!, personalUrl: personalJoinUrl(match.joinUrl, seat!.seatToken), reused: false }
  })
}
