import { describe, expect, it, vi } from 'vitest'
import { matches, seats } from '../src/db/schema.js'
import { catanCommand } from '../src/commands/catan.js'
import { wordyCommand } from '../src/commands/wordy.js'
import { playCommand, type PlayDeps } from '../src/commands/play.js'
import { GameLaunchError } from '../src/game-client.js'
import { launchMatch } from '../src/matches.js'
import { testDb } from './helpers/db.js'

const LAUNCHED = { code: 'ABCD', joinUrl: 'http://play.example/?join=ABCD', expiresAt: '2026-09-12T12:00:00.000Z' }

interface FakeInteraction {
  options: { getString: (name: string, required?: boolean) => string | null }
  guildId: string | null
  channelId: string
  user: { id: string; displayName: string }
  reply: ReturnType<typeof vi.fn>
  followUp: ReturnType<typeof vi.fn>
}

function fakeInteraction(opts: { game?: string; guildId?: string | null } = {}): FakeInteraction {
  return {
    options: { getString: () => opts.game ?? null },
    guildId: opts.guildId === undefined ? 'g1' : opts.guildId,
    channelId: 'c1',
    user: { id: 'u1', displayName: 'Ayo' },
    reply: vi.fn(async () => ({ id: 'msg1' })),
    followUp: vi.fn(async () => undefined),
  }
}

function deps(db: Awaited<ReturnType<typeof testDb>>, createMatch = vi.fn(async () => LAUNCHED)): PlayDeps {
  return {
    db,
    launch: (args) => launchMatch({ ...args, createMatch }),
    publicBaseUrl: 'http://steward.example',
  }
}

describe('/play', () => {
  it('launches the match at once with the invoker as host, posts the Join embed, and hands the host their link privately', async () => {
    const db = await testDb()
    const i = fakeInteraction({ game: 'catan' })
    await playCommand.execute(i as never, deps(db))
    const [match] = await db.select().from(matches)
    expect(match).toMatchObject({ gameSlug: 'catan', code: 'ABCD', createdByDiscordId: 'u1', players: 4, bots: 0 })
    const [hostSeat] = await db.select().from(seats)
    expect(hostSeat!.discordUserId).toBe('u1')
    const reply = JSON.stringify(i.reply.mock.calls[0]![0])
    expect(reply).toContain(`join:${match!.id}`)
    expect(reply).toContain('ABCD')
    const dm = i.followUp.mock.calls[0]![0] as { content: string; flags: unknown }
    expect(dm.content).toContain(`seat=${hostSeat!.seatToken}`)
    expect(dm.flags).toBeTruthy()
  })

  it('tells the invoker privately when the game cannot be launched, and stores nothing', async () => {
    const db = await testDb()
    const i = fakeInteraction({ game: 'catan' })
    await playCommand.execute(i as never, deps(db, vi.fn(async () => { throw new GameLaunchError('could not reach the game server') })))
    const reply = i.reply.mock.calls[0]![0] as { content: string; flags: unknown }
    expect(reply.content).toContain('Could not launch the match')
    expect(reply.flags).toBeTruthy()
    expect(await db.select().from(matches)).toHaveLength(0)
    expect(i.followUp).not.toHaveBeenCalled()
  })

  it('rejects unknown games and DMs (no guild)', async () => {
    const db = await testDb()
    const bad = fakeInteraction({ game: 'chess' })
    await playCommand.execute(bad as never, deps(db))
    expect(JSON.stringify(bad.reply.mock.calls[0]![0])).toContain('Unknown game')
    const dm = fakeInteraction({ game: 'catan', guildId: null })
    await playCommand.execute(dm as never, deps(db))
    expect(JSON.stringify(dm.reply.mock.calls[0]![0])).toContain('server channel')
    expect(await db.select().from(matches)).toHaveLength(0)
  })

  it('autocompletes games by name fragment', async () => {
    const respond = vi.fn(async () => undefined)
    await playCommand.autocomplete({ options: { getFocused: () => 'cat' }, respond } as never)
    expect(respond).toHaveBeenCalledWith([{ name: 'CATAN (Meridian)', value: 'catan' }])
  })
})

describe('/catan alias', () => {
  it('launches a catan match through the same path', async () => {
    const db = await testDb()
    const i = fakeInteraction({})
    await catanCommand.execute(i as never, deps(db))
    const [match] = await db.select().from(matches)
    expect(match!.gameSlug).toBe('catan')
  })
})

describe('/wordy alias', () => {
  it('launches a wordy match through the same path', async () => {
    const db = await testDb()
    const i = fakeInteraction({})
    await wordyCommand.execute(i as never, deps(db))
    const [match] = await db.select().from(matches)
    expect(match).toMatchObject({ gameSlug: 'wordy', players: 4, bots: 0 })
  })
})
