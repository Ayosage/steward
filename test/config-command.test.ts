import { describe, expect, it, vi } from 'vitest'
import { configCommand } from '../src/commands/config.js'
import { guildConfig } from '../src/db/schema.js'
import { testDb } from './helpers/db.js'

function fakeInteraction(channelId: string) {
  return {
    guildId: 'g1',
    options: {
      getSubcommand: () => 'match-log',
      getChannel: (_name: string, _required: boolean) => ({ id: channelId, toString: () => `<#${channelId}>` }),
    },
    reply: vi.fn(async () => undefined),
  }
}

describe('/config match-log', () => {
  it('upserts the guild match-log channel', async () => {
    const db = await testDb()
    await configCommand.execute(fakeInteraction('c-log') as never, { db })
    await configCommand.execute(fakeInteraction('c-log2') as never, { db })
    const rows = await db.select().from(guildConfig)
    expect(rows).toEqual([{ guildId: 'g1', matchLogChannelId: 'c-log2' }])
  })

  it('declares admin default permissions', () => {
    const json = configCommand.data.toJSON()
    expect(json.default_member_permissions).toBeDefined()
  })
})
