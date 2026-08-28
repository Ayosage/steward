import { describe, expect, it, vi } from 'vitest'
import { rolesCommand } from '../src/commands/roles.js'
import { gameRoles } from '../src/db/schema.js'
import { handleRoleSelect, isRoleSelect } from '../src/interactions/roles.js'
import { testDb } from './helpers/db.js'

function fakeSetupInteraction(existingRoleNames: Record<string, string> = {}) {
  const created: string[] = []
  return {
    created,
    guildId: 'g1',
    guild: {
      roles: {
        cache: {
          find: (fn: (r: { name: string; id: string }) => boolean) => {
            const found = Object.entries(existingRoleNames).map(([name, id]) => ({ name, id })).find(fn)
            return found
          },
        },
        create: vi.fn(async ({ name }: { name: string }) => {
          created.push(name)
          return { id: `r-${name}`, name }
        }),
      },
    },
    options: { getSubcommand: () => 'setup' },
    reply: vi.fn(async (_opts: { content: string; components?: unknown[] }) => undefined),
  }
}

describe('/roles setup', () => {
  it('creates missing roles, stores the mapping, and posts a select menu', async () => {
    const db = await testDb()
    const i = fakeSetupInteraction()
    await rolesCommand.execute(i as never, { db })
    expect(i.created).toEqual(['CATAN (Meridian)'])
    const rows = await db.select().from(gameRoles)
    expect(rows).toEqual([{ guildId: 'g1', gameSlug: 'catan', roleId: 'r-CATAN (Meridian)' }])
    const reply = JSON.stringify(i.reply.mock.calls[0]![0])
    expect(reply).toContain('roles:pick')
  })

  it('reuses an existing role with the game name', async () => {
    const db = await testDb()
    const i = fakeSetupInteraction({ 'CATAN (Meridian)': 'r-existing' })
    await rolesCommand.execute(i as never, { db })
    expect(i.created).toEqual([])
    const rows = await db.select().from(gameRoles)
    expect(rows[0]!.roleId).toBe('r-existing')
  })
})

describe('role select', () => {
  it('recognizes its customId', () => {
    expect(isRoleSelect('roles:pick')).toBe(true)
    expect(isRoleSelect('join:7')).toBe(false)
  })

  it('toggles the mapped role on the member', async () => {
    const db = await testDb()
    await db.insert(gameRoles).values({ guildId: 'g1', gameSlug: 'catan', roleId: 'r1' })
    const add = vi.fn(async () => undefined)
    const remove = vi.fn(async () => undefined)
    const base = {
      guildId: 'g1',
      values: ['catan'],
      reply: vi.fn(async () => undefined),
    }
    const without = { ...base, member: { roles: { cache: { has: () => false }, add, remove } } }
    await handleRoleSelect(without as never, db)
    expect(add).toHaveBeenCalledWith('r1')
    const withRole = { ...base, member: { roles: { cache: { has: () => true }, add, remove } } }
    await handleRoleSelect(withRole as never, db)
    expect(remove).toHaveBeenCalledWith('r1')
  })
})
