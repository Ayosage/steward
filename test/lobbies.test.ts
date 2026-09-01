import { describe, expect, it, vi } from 'vitest'
import { matches } from '../src/db/schema.js'
import { getGame } from '../src/games.js'
import {
  HostCannotLeaveError,
  LobbyClosedError,
  LobbyFullError,
  NotHostError,
  NotMemberError,
  StartInvalidError,
  cancelLobby,
  createLobby,
  setBots,
  startLobby,
  toggleMember,
  transferHost,
} from '../src/lobbies.js'
import { launchMatch } from '../src/matches.js'
import { testDb } from './helpers/db.js'

const catan = getGame('catan')!
const LAUNCHED = { code: 'ABCD', joinUrl: 'http://play.example/?join=ABCD', expiresAt: '2026-09-02T12:00:00.000Z' }

const host = { id: 'h1', displayName: 'Host' }
const alice = { id: 'a1', displayName: 'Alice' }
const bob = { id: 'b1', displayName: 'Bob' }

async function openLobby(db: Awaited<ReturnType<typeof testDb>>) {
  return createLobby(db, { game: catan, guildId: 'g1', channelId: 'c1', host })
}

function launchDeps() {
  return {
    launch: (args: Parameters<typeof launchMatch>[0]) => launchMatch({ ...args, createMatch: vi.fn(async () => LAUNCHED) }),
    publicBaseUrl: 'http://steward.example',
  }
}

describe('lobby lifecycle', () => {
  it('creates an open lobby with the host auto-joined', async () => {
    const db = await testDb()
    const { lobby, members } = await openLobby(db)
    expect(lobby.status).toBe('open')
    expect(lobby.hostDiscordId).toBe(host.id)
    expect(lobby.bots).toBe(0)
    expect(members.map((m) => m.discordUserId)).toEqual([host.id])
  })

  it('toggleMember joins then leaves', async () => {
    const db = await testDb()
    const { lobby } = await openLobby(db)
    const joined = await toggleMember(db, lobby.id, alice, catan)
    expect(joined.action).toBe('joined')
    expect(joined.members).toHaveLength(2)
    const left = await toggleMember(db, lobby.id, alice, catan)
    expect(left.action).toBe('left')
    expect(left.members.map((m) => m.discordUserId)).toEqual([host.id])
  })

  it('the host cannot leave via toggle', async () => {
    const db = await testDb()
    const { lobby } = await openLobby(db)
    await expect(toggleMember(db, lobby.id, host, catan)).rejects.toBeInstanceOf(HostCannotLeaveError)
  })

  it('rejects joins once humans + bots reach the seat cap', async () => {
    const db = await testDb()
    const { lobby } = await openLobby(db)
    await setBots(db, lobby.id, host.id, +7, catan) // clamped to maxPlayers - 1 human = 7
    await expect(toggleMember(db, lobby.id, alice, catan)).rejects.toBeInstanceOf(LobbyFullError)
  })

  it('setBots clamps to 0..(maxPlayers - humans) and is host-only', async () => {
    const db = await testDb()
    const { lobby } = await openLobby(db)
    await toggleMember(db, lobby.id, alice, catan)
    const up = await setBots(db, lobby.id, host.id, +99, catan)
    expect(up.lobby.bots).toBe(6) // 8 seats - 2 humans
    const down = await setBots(db, lobby.id, host.id, -99, catan)
    expect(down.lobby.bots).toBe(0)
    await expect(setBots(db, lobby.id, alice.id, +1, catan)).rejects.toBeInstanceOf(NotHostError)
  })

  it('transfers host to a member; rejects non-members and non-host actors', async () => {
    const db = await testDb()
    const { lobby } = await openLobby(db)
    await toggleMember(db, lobby.id, alice, catan)
    await expect(transferHost(db, lobby.id, alice.id, alice.id)).rejects.toBeInstanceOf(NotHostError)
    await expect(transferHost(db, lobby.id, host.id, bob.id)).rejects.toBeInstanceOf(NotMemberError)
    const { lobby: after } = await transferHost(db, lobby.id, host.id, alice.id)
    expect(after.hostDiscordId).toBe(alice.id)
    // old host is now a regular member and can leave
    const left = await toggleMember(db, lobby.id, host, catan)
    expect(left.action).toBe('left')
  })

  it('cancel is host-only and closes the lobby', async () => {
    const db = await testDb()
    const { lobby } = await openLobby(db)
    await toggleMember(db, lobby.id, alice, catan)
    await expect(cancelLobby(db, lobby.id, alice.id)).rejects.toBeInstanceOf(NotHostError)
    const { lobby: after } = await cancelLobby(db, lobby.id, host.id)
    expect(after.status).toBe('cancelled')
    await expect(toggleMember(db, lobby.id, bob, catan)).rejects.toBeInstanceOf(LobbyClosedError)
  })

  it('start rejects when humans + bots are below the game minimum', async () => {
    const db = await testDb()
    const { lobby } = await openLobby(db)
    await expect(startLobby(db, lobby.id, host.id, catan, launchDeps())).rejects.toBeInstanceOf(StartInvalidError)
  })

  it('start is host-only, launches with players = humans + bots, and closes the lobby', async () => {
    const db = await testDb()
    const { lobby } = await openLobby(db)
    await toggleMember(db, lobby.id, alice, catan)
    await setBots(db, lobby.id, host.id, +1, catan)
    await expect(startLobby(db, lobby.id, alice.id, catan, launchDeps())).rejects.toBeInstanceOf(NotHostError)
    const started = await startLobby(db, lobby.id, host.id, catan, launchDeps())
    expect(started.lobby.status).toBe('started')
    expect(started.match.players).toBe(3)
    expect(started.match.bots).toBe(1)
    expect(started.lobby.matchId).toBe(started.match.id)
    await expect(startLobby(db, lobby.id, host.id, catan, launchDeps())).rejects.toBeInstanceOf(LobbyClosedError)
  })

  it('a failed launch reopens the lobby', async () => {
    const db = await testDb()
    const { lobby } = await openLobby(db)
    await toggleMember(db, lobby.id, alice, catan)
    await setBots(db, lobby.id, host.id, +1, catan)
    const failing = { launch: vi.fn(async () => Promise.reject(new Error('boom'))), publicBaseUrl: 'x' }
    await expect(startLobby(db, lobby.id, host.id, catan, failing as never)).rejects.toThrow('boom')
    const retry = await startLobby(db, lobby.id, host.id, catan, launchDeps())
    expect(retry.lobby.status).toBe('started')
    expect(await db.select().from(matches)).toHaveLength(1)
  })
})
