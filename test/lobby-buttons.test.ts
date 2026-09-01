import { describe, expect, it, vi } from 'vitest'
import { getGame } from '../src/games.js'
import { createLobby, getLobbyView, toggleMember } from '../src/lobbies.js'
import { launchMatch } from '../src/matches.js'
import { handleLobbyButton, handleLobbyHostSelect, type LobbyDeps } from '../src/interactions/lobby.js'
import { testDb } from './helpers/db.js'

const catan = getGame('catan')!
const LAUNCHED = { code: 'ABCD', joinUrl: 'http://play.example/?join=ABCD', expiresAt: '2026-09-02T12:00:00.000Z' }

function lobbyDeps(db: Awaited<ReturnType<typeof testDb>>): LobbyDeps {
  return {
    db,
    start: {
      launch: (args) => launchMatch({ ...args, createMatch: vi.fn(async () => LAUNCHED) }),
      publicBaseUrl: 'http://steward.example',
    },
  }
}

function fakeButton(customId: string, userId: string, displayName = userId) {
  const i = {
    customId,
    user: { id: userId, displayName },
    deferred: false,
    replied: false,
    update: vi.fn(async (_opts: unknown) => undefined),
    reply: vi.fn(async (_opts: unknown) => undefined),
    deferUpdate: vi.fn(async () => {
      i.deferred = true
    }),
    editReply: vi.fn(async (_opts: unknown) => undefined),
    followUp: vi.fn(async (_opts: unknown) => undefined),
  }
  return i
}

async function seedLobby(db: Awaited<ReturnType<typeof testDb>>) {
  const { lobby } = await createLobby(db, {
    game: catan,
    guildId: 'g1',
    channelId: 'c1',
    host: { id: 'h1', displayName: 'Host' },
  })
  return lobby
}

describe('lobby buttons', () => {
  it('Join toggles membership and re-renders the lobby message', async () => {
    const db = await testDb()
    const lobby = await seedLobby(db)
    const i = fakeButton(`lobby:${lobby.id}:join`, 'a1', 'Alice')
    await handleLobbyButton(i as never, lobbyDeps(db))
    expect(i.update).toHaveBeenCalled()
    expect(JSON.stringify(i.update.mock.calls[0]![0])).toContain('a1')
  })

  it('the host cannot leave; gets an ephemeral explanation', async () => {
    const db = await testDb()
    const lobby = await seedLobby(db)
    const i = fakeButton(`lobby:${lobby.id}:join`, 'h1', 'Host')
    await handleLobbyButton(i as never, lobbyDeps(db))
    expect(i.update).not.toHaveBeenCalled()
    expect(JSON.stringify(i.reply.mock.calls[0]![0])).toContain('give host')
  })

  it('+ Bot is host-only', async () => {
    const db = await testDb()
    const lobby = await seedLobby(db)
    const stranger = fakeButton(`lobby:${lobby.id}:botadd`, 'a1')
    await handleLobbyButton(stranger as never, lobbyDeps(db))
    expect(JSON.stringify(stranger.reply.mock.calls[0]![0])).toContain('Only the host')
    const host = fakeButton(`lobby:${lobby.id}:botadd`, 'h1')
    await handleLobbyButton(host as never, lobbyDeps(db))
    expect((await getLobbyView(db, lobby.id))!.lobby.bots).toBe(1)
  })

  it('Cancel closes the lobby and strips the buttons', async () => {
    const db = await testDb()
    const lobby = await seedLobby(db)
    const i = fakeButton(`lobby:${lobby.id}:cancel`, 'h1')
    await handleLobbyButton(i as never, lobbyDeps(db))
    const payload = i.update.mock.calls[0]![0] as { components: unknown[] }
    expect(payload.components).toHaveLength(0)
    expect((await getLobbyView(db, lobby.id))!.lobby.status).toBe('cancelled')
  })

  it('Start below the minimum explains ephemerally and keeps the lobby open', async () => {
    const db = await testDb()
    const lobby = await seedLobby(db)
    const i = fakeButton(`lobby:${lobby.id}:start`, 'h1')
    await handleLobbyButton(i as never, lobbyDeps(db))
    expect(JSON.stringify(i.followUp.mock.calls[0]![0])).toContain('Cannot start')
    expect((await getLobbyView(db, lobby.id))!.lobby.status).toBe('open')
  })

  it('Start launches and swaps the message to the match embed + Join button', async () => {
    const db = await testDb()
    const lobby = await seedLobby(db)
    await toggleMember(db, lobby.id, { id: 'a1', displayName: 'Alice' }, catan)
    await toggleMember(db, lobby.id, { id: 'b1', displayName: 'Bob' }, catan)
    const i = fakeButton(`lobby:${lobby.id}:start`, 'h1')
    await handleLobbyButton(i as never, lobbyDeps(db))
    const payload = JSON.stringify(i.editReply.mock.calls[0]![0])
    expect(payload).toContain('ABCD')
    expect(payload).toContain('join:')
    expect((await getLobbyView(db, lobby.id))!.lobby.status).toBe('started')
  })

  it('Give Host with nobody else present says so', async () => {
    const db = await testDb()
    const lobby = await seedLobby(db)
    const i = fakeButton(`lobby:${lobby.id}:givehost`, 'h1')
    await handleLobbyButton(i as never, lobbyDeps(db))
    expect(JSON.stringify(i.reply.mock.calls[0]![0])).toContain('Nobody else')
  })

  it('host select transfers host and confirms', async () => {
    const db = await testDb()
    const lobby = await seedLobby(db)
    await toggleMember(db, lobby.id, { id: 'a1', displayName: 'Alice' }, catan)
    const i = {
      customId: `lobbyhost:${lobby.id}`,
      values: ['a1'],
      user: { id: 'h1', displayName: 'Host' },
      update: vi.fn(async (_opts: unknown) => undefined),
      client: { channels: { fetch: vi.fn(async () => null) } },
    }
    await handleLobbyHostSelect(i as never, lobbyDeps(db))
    expect((await getLobbyView(db, lobby.id))!.lobby.hostDiscordId).toBe('a1')
    expect(JSON.stringify(i.update.mock.calls[0]![0])).toContain('a1')
  })
})
