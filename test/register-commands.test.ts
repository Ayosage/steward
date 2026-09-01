import { describe, expect, it, vi } from 'vitest'
import { Routes } from 'discord.js'
import { commands } from '../src/commands/index.js'
import { registerCommands } from '../src/register-commands.js'

function fakeRest() {
  const put = vi.fn(async (_route: string, opts: { body: unknown }) => opts.body as unknown[])
  return { rest: { put }, put }
}

describe('registerCommands', () => {
  it('registers globally when no guild id is given', async () => {
    const { rest, put } = fakeRest()
    const result = await registerCommands(rest, 'app1')
    expect(put).toHaveBeenCalledWith(Routes.applicationCommands('app1'), expect.anything())
    expect(result.scope).toBe('global')
    expect(result.count).toBe(commands.size)
  })

  it('registers guild-scoped when a guild id is given', async () => {
    const { rest, put } = fakeRest()
    const result = await registerCommands(rest, 'app1', 'g42')
    expect(put).toHaveBeenCalledWith(Routes.applicationGuildCommands('app1', 'g42'), expect.anything())
    expect(result.scope).toBe('guild g42')
  })

  it('sends every command definition as the body', async () => {
    const { rest, put } = fakeRest()
    await registerCommands(rest, 'app1')
    const body = put.mock.calls[0]![1].body as { name: string }[]
    expect(body.map((c) => c.name).sort()).toEqual([...commands.keys()].sort())
  })
})
