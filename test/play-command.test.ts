import { describe, expect, it, vi } from 'vitest'
import { matches } from '../src/db/schema.js'
import { catanCommand } from '../src/commands/catan.js'
import { playCommand, type PlayDeps } from '../src/commands/play.js'
import { launchMatch } from '../src/matches.js'
import { testDb } from './helpers/db.js'

const LAUNCHED = { code: 'ABCD', joinUrl: 'http://play.example/?join=ABCD', expiresAt: '2026-08-27T12:00:00.000Z' }

interface FakeInteraction {
  options: {
    getString: (name: string, required?: boolean) => string | null
    getInteger: (name: string) => number | null
  }
  guildId: string | null
  channelId: string
  user: { id: string; displayName: string }
  deferReply: ReturnType<typeof vi.fn>
  editReply: ReturnType<typeof vi.fn>
  reply: ReturnType<typeof vi.fn>
}

function fakeInteraction(opts: { game?: string; players?: number; bots?: number; guildId?: string | null } = {}): FakeInteraction {
  return {
    options: {
      getString: () => opts.game ?? null,
      getInteger: (name) => (name === 'players' ? (opts.players ?? null) : (opts.bots ?? null)),
    },
    guildId: opts.guildId === undefined ? 'g1' : opts.guildId,
    channelId: 'c1',
    user: { id: 'u1', displayName: 'Ayo' },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  }
}

function deps(db: Awaited<ReturnType<typeof testDb>>): PlayDeps {
  return {
    db,
    launch: (args) => launchMatch({ ...args, createMatch: vi.fn(async () => LAUNCHED) }),
    publicBaseUrl: 'http://steward.example',
  }
}

describe('/play', () => {
  it('launches, persists the match, and posts embed + Join button', async () => {
    const db = await testDb()
    const i = fakeInteraction({ game: 'catan', players: 4, bots: 1 })
    await playCommand.execute(i as never, deps(db))
    const rows = await db.select().from(matches)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.guildId).toBe('g1')
    const reply = JSON.stringify(i.editReply.mock.calls[0]![0])
    expect(reply).toContain('ABCD')
    expect(reply).toContain(`join:${rows[0]!.id}`)
  })

  it('rejects out-of-bounds players ephemerally without calling the game', async () => {
    const db = await testDb()
    const i = fakeInteraction({ game: 'catan', players: 9 })
    await playCommand.execute(i as never, deps(db))
    expect(i.deferReply).not.toHaveBeenCalled()
    expect(JSON.stringify(i.reply.mock.calls[0]![0])).toContain('players must be 3..8')
    expect(await db.select().from(matches)).toHaveLength(0)
  })

  it('rejects unknown games and DMs (no guild)', async () => {
    const db = await testDb()
    const bad = fakeInteraction({ game: 'chess' })
    await playCommand.execute(bad as never, deps(db))
    expect(JSON.stringify(bad.reply.mock.calls[0]![0])).toContain('Unknown game')
    const dm = fakeInteraction({ game: 'catan', guildId: null })
    await playCommand.execute(dm as never, deps(db))
    expect(JSON.stringify(dm.reply.mock.calls[0]![0])).toContain('server channel')
  })

  it('autocompletes games by name fragment', async () => {
    const respond = vi.fn(async () => undefined)
    await playCommand.autocomplete({ options: { getFocused: () => 'cat' }, respond } as never)
    expect(respond).toHaveBeenCalledWith([{ name: 'CATAN (Meridian)', value: 'catan' }])
  })
})

describe('/catan alias', () => {
  it('uses the same launch path with the catan slug', async () => {
    const db = await testDb()
    const i = fakeInteraction({ players: 3 })
    await catanCommand.execute(i as never, deps(db))
    const rows = await db.select().from(matches)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.gameSlug).toBe('catan')
    expect(rows[0]!.players).toBe(3)
  })
})
