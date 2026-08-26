import { describe, expect, it, vi } from 'vitest'
import { catanCommand, type CatanDeps } from '../src/commands/catan.js'
import { MeridianLaunchError } from '../src/meridian.js'

interface FakeInteraction {
  options: { getInteger: (name: string) => number | null }
  user: { displayName: string }
  deferReply: ReturnType<typeof vi.fn>
  editReply: ReturnType<typeof vi.fn>
}

function fakeInteraction(opts: { players?: number | null; bots?: number | null } = {}): FakeInteraction {
  return {
    options: {
      getInteger: (name: string) => (name === 'players' ? (opts.players ?? null) : (opts.bots ?? null)),
    },
    user: { displayName: 'Ayo' },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  }
}

const MATCH = { code: 'ABCD', joinUrl: 'http://play.example/?join=ABCD', expiresAt: '2026-08-26T12:00:00.000Z' }

describe('/catan command', () => {
  it('declares name, player and bot options', () => {
    const json = catanCommand.data.toJSON()
    expect(json.name).toBe('catan')
    const names = (json.options ?? []).map((o) => o.name)
    expect(names).toContain('players')
    expect(names).toContain('bots')
  })

  it('launches with defaults (4 players, 0 bots) and replies with the join link', async () => {
    const deps: CatanDeps = { createMatch: vi.fn(async () => MATCH) }
    const i = fakeInteraction()
    await catanCommand.execute(i as never, deps)
    expect(deps.createMatch).toHaveBeenCalledWith({ players: 4, bots: 0, seatNames: ['Ayo'] })
    expect(i.deferReply).toHaveBeenCalled()
    const reply = i.editReply.mock.calls[0]![0] as { embeds: { toJSON(): { description?: string; fields?: { name: string; value: string }[] } }[] }
    const embed = reply.embeds[0]!.toJSON()
    const flat = JSON.stringify(embed)
    expect(flat).toContain('http://play.example/?join=ABCD')
    expect(flat).toContain('ABCD')
  })

  it('passes explicit players/bots through', async () => {
    const deps: CatanDeps = { createMatch: vi.fn(async () => MATCH) }
    await catanCommand.execute(fakeInteraction({ players: 8, bots: 3 }) as never, deps)
    expect(deps.createMatch).toHaveBeenCalledWith({ players: 8, bots: 3, seatNames: ['Ayo'] })
  })

  it('reports a launch failure as a plain reply, not a crash', async () => {
    const deps: CatanDeps = {
      createMatch: vi.fn(async () => {
        throw new MeridianLaunchError('players must be 3..8')
      }),
    }
    const i = fakeInteraction({ players: 9 })
    await catanCommand.execute(i as never, deps)
    const reply = i.editReply.mock.calls[0]![0] as { content: string }
    expect(reply.content).toContain('players must be 3..8')
  })
})
