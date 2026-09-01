import { and, asc, eq } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { lobbies, lobbyMembers, type LobbyMemberRow, type LobbyRow, type MatchRow } from './db/schema.js'
import type { GameDef } from './games.js'
import { validateLaunch } from './games.js'
import type { launchMatch } from './matches.js'

export class LobbyClosedError extends Error {}
export class LobbyFullError extends Error {}
export class NotHostError extends Error {}
export class NotMemberError extends Error {}
export class HostCannotLeaveError extends Error {}
/** message is user-facing (comes from validateLaunch) */
export class StartInvalidError extends Error {}

export interface LobbyView {
  lobby: LobbyRow
  members: LobbyMemberRow[]
}

export interface LobbyUser {
  id: string
  displayName: string
}

async function membersOf(db: Db, lobbyId: number): Promise<LobbyMemberRow[]> {
  return db.select().from(lobbyMembers).where(eq(lobbyMembers.lobbyId, lobbyId)).orderBy(asc(lobbyMembers.joinedAt))
}

export async function getLobbyView(db: Db, lobbyId: number): Promise<LobbyView | undefined> {
  const [lobby] = await db.select().from(lobbies).where(eq(lobbies.id, lobbyId))
  if (!lobby) return undefined
  return { lobby, members: await membersOf(db, lobbyId) }
}

export interface CreateLobbyArgs {
  game: GameDef
  guildId: string
  channelId: string
  host: LobbyUser
}

export async function createLobby(db: Db, args: CreateLobbyArgs): Promise<LobbyView> {
  return db.transaction(async (tx) => {
    const [lobby] = await tx
      .insert(lobbies)
      .values({
        guildId: args.guildId,
        channelId: args.channelId,
        gameSlug: args.game.slug,
        hostDiscordId: args.host.id,
      })
      .returning()
    await tx
      .insert(lobbyMembers)
      .values({ lobbyId: lobby!.id, discordUserId: args.host.id, displayName: args.host.displayName })
    return { lobby: lobby!, members: await membersOf(tx as unknown as Db, lobby!.id) }
  })
}

/** Row-lock the lobby so concurrent button clicks serialize; throws if not open. */
async function lockOpenLobby(tx: Db, lobbyId: number): Promise<LobbyRow> {
  const [lobby] = await tx.select().from(lobbies).where(eq(lobbies.id, lobbyId)).for('update')
  if (!lobby) throw new LobbyClosedError('lobby no longer exists')
  if (lobby.status !== 'open') throw new LobbyClosedError('lobby is closed')
  return lobby
}

export interface ToggleResult extends LobbyView {
  action: 'joined' | 'left'
}

export async function toggleMember(db: Db, lobbyId: number, user: LobbyUser, game: GameDef): Promise<ToggleResult> {
  return db.transaction(async (tx) => {
    const lobby = await lockOpenLobby(tx as unknown as Db, lobbyId)
    const members = await membersOf(tx as unknown as Db, lobbyId)
    const existing = members.find((m) => m.discordUserId === user.id)
    if (existing) {
      if (lobby.hostDiscordId === user.id)
        throw new HostCannotLeaveError('give host to someone else (or cancel) first')
      await tx
        .delete(lobbyMembers)
        .where(and(eq(lobbyMembers.lobbyId, lobbyId), eq(lobbyMembers.discordUserId, user.id)))
      return { action: 'left' as const, lobby, members: members.filter((m) => m.discordUserId !== user.id) }
    }
    if (members.length + lobby.bots >= game.maxPlayers) throw new LobbyFullError('all seats are taken')
    const [added] = await tx
      .insert(lobbyMembers)
      .values({ lobbyId, discordUserId: user.id, displayName: user.displayName })
      .returning()
    return { action: 'joined' as const, lobby, members: [...members, added!] }
  })
}

function assertHost(lobby: LobbyRow, actorId: string): void {
  if (lobby.hostDiscordId !== actorId) throw new NotHostError('only the host can do that')
}

export async function setBots(db: Db, lobbyId: number, actorId: string, delta: number, game: GameDef): Promise<LobbyView> {
  return db.transaction(async (tx) => {
    const lobby = await lockOpenLobby(tx as unknown as Db, lobbyId)
    assertHost(lobby, actorId)
    const members = await membersOf(tx as unknown as Db, lobbyId)
    const maxBots = Math.min(game.maxBots, game.maxPlayers - members.length)
    const bots = Math.max(0, Math.min(maxBots, lobby.bots + delta))
    const [updated] = await tx.update(lobbies).set({ bots }).where(eq(lobbies.id, lobbyId)).returning()
    return { lobby: updated!, members }
  })
}

export async function transferHost(db: Db, lobbyId: number, actorId: string, newHostId: string): Promise<LobbyView> {
  return db.transaction(async (tx) => {
    const lobby = await lockOpenLobby(tx as unknown as Db, lobbyId)
    assertHost(lobby, actorId)
    const members = await membersOf(tx as unknown as Db, lobbyId)
    if (!members.some((m) => m.discordUserId === newHostId)) throw new NotMemberError('new host must be in the lobby')
    const [updated] = await tx.update(lobbies).set({ hostDiscordId: newHostId }).where(eq(lobbies.id, lobbyId)).returning()
    return { lobby: updated!, members }
  })
}

export async function cancelLobby(db: Db, lobbyId: number, actorId: string): Promise<LobbyView> {
  return db.transaction(async (tx) => {
    const lobby = await lockOpenLobby(tx as unknown as Db, lobbyId)
    assertHost(lobby, actorId)
    const members = await membersOf(tx as unknown as Db, lobbyId)
    const [updated] = await tx.update(lobbies).set({ status: 'cancelled' }).where(eq(lobbies.id, lobbyId)).returning()
    return { lobby: updated!, members }
  })
}

export interface StartDeps {
  launch: typeof launchMatch
  publicBaseUrl: string
}

export interface StartedLobby extends LobbyView {
  match: MatchRow
}

/**
 * Claims the lobby (open → started) before the launch HTTP call so double
 * Start clicks can't double-launch; a failed launch reopens it.
 */
export async function startLobby(
  db: Db,
  lobbyId: number,
  actorId: string,
  game: GameDef,
  deps: StartDeps,
): Promise<StartedLobby> {
  const { lobby, members } = await db.transaction(async (tx) => {
    const locked = await lockOpenLobby(tx as unknown as Db, lobbyId)
    assertHost(locked, actorId)
    const members = await membersOf(tx as unknown as Db, lobbyId)
    const players = members.length + locked.bots
    const invalid = validateLaunch(game, players, locked.bots)
    if (invalid) throw new StartInvalidError(invalid)
    const [claimed] = await tx.update(lobbies).set({ status: 'started' }).where(eq(lobbies.id, lobbyId)).returning()
    return { lobby: claimed!, members }
  })
  try {
    const match = await deps.launch({
      db,
      game,
      players: members.length + lobby.bots,
      bots: lobby.bots,
      guildId: lobby.guildId,
      channelId: lobby.channelId,
      createdByDiscordId: actorId,
      publicBaseUrl: deps.publicBaseUrl,
    })
    const [linked] = await db.update(lobbies).set({ matchId: match.id }).where(eq(lobbies.id, lobbyId)).returning()
    return { lobby: linked!, members, match }
  } catch (e) {
    await db.update(lobbies).set({ status: 'open' }).where(eq(lobbies.id, lobbyId))
    throw e
  }
}
