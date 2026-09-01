import { describe, expect, it, vi } from 'vitest'
import { lobbies, lobbyMembers } from '../src/db/schema.js'
import { catanCommand } from '../src/commands/catan.js'
import { playCommand, type PlayDeps } from '../src/commands/play.js'
import { testDb } from './helpers/db.js'

interface FakeInteraction {
  options: { getString: (name: string, required?: boolean) => string | null }
  guildId: string | null
  channelId: string
  user: { id: string; displayName: string }
  reply: ReturnType<typeof vi.fn>
}

function fakeInteraction(opts: { game?: string; guildId?: string | null } = {}): FakeInteraction {
  return {
    options: { getString: () => opts.game ?? null },
    guildId: opts.guildId === undefined ? 'g1' : opts.guildId,
    channelId: 'c1',
    user: { id: 'u1', displayName: 'Ayo' },
    reply: vi.fn(async () => ({ id: 'msg1' })),
  }
}

function deps(db: Awaited<ReturnType<typeof testDb>>): PlayDeps {
  return { db }
}

describe('/play', () => {
  it('opens a lobby with the invoker as host and posts the lobby embed + buttons', async () => {
    const db = await testDb()
    const i = fakeInteraction({ game: 'catan' })
    await playCommand.execute(i as never, deps(db))
    const [lobby] = await db.select().from(lobbies)
    expect(lobby!.hostDiscordId).toBe('u1')
    expect(lobby!.status).toBe('open')
    expect(lobby!.messageId).toBe('msg1')
    const members = await db.select().from(lobbyMembers)
    expect(members.map((m) => m.discordUserId)).toEqual(['u1'])
    const reply = JSON.stringify(i.reply.mock.calls[0]![0])
    expect(reply).toContain(`lobby:${lobby!.id}:join`)
    expect(reply).toContain(`lobby:${lobby!.id}:start`)
  })

  it('rejects unknown games and DMs (no guild)', async () => {
    const db = await testDb()
    const bad = fakeInteraction({ game: 'chess' })
    await playCommand.execute(bad as never, deps(db))
    expect(JSON.stringify(bad.reply.mock.calls[0]![0])).toContain('Unknown game')
    const dm = fakeInteraction({ game: 'catan', guildId: null })
    await playCommand.execute(dm as never, deps(db))
    expect(JSON.stringify(dm.reply.mock.calls[0]![0])).toContain('server channel')
    expect(await db.select().from(lobbies)).toHaveLength(0)
  })

  it('autocompletes games by name fragment', async () => {
    const respond = vi.fn(async () => undefined)
    await playCommand.autocomplete({ options: { getFocused: () => 'cat' }, respond } as never)
    expect(respond).toHaveBeenCalledWith([{ name: 'CATAN (Meridian)', value: 'catan' }])
  })
})

describe('/catan alias', () => {
  it('opens a catan lobby through the same path', async () => {
    const db = await testDb()
    const i = fakeInteraction({})
    await catanCommand.execute(i as never, deps(db))
    const [lobby] = await db.select().from(lobbies)
    expect(lobby!.gameSlug).toBe('catan')
  })
})
