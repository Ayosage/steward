import { describe, expect, it, vi } from 'vitest'
import { gamenightCommand } from '../src/commands/gamenight.js'
import { scheduledAnnouncements } from '../src/db/schema.js'
import { testDb } from './helpers/db.js'

function fakeInteraction(sub: string, opts: Record<string, unknown> = {}) {
  return {
    guildId: 'g1',
    options: {
      getSubcommand: () => sub,
      getChannel: () => opts['channel'] ?? { id: 'c1', toString: () => '<#c1>' },
      getString: (name: string) => (opts[name] as string | undefined) ?? null,
      getInteger: (name: string) => (opts[name] as number | undefined) ?? null,
    },
    reply: vi.fn(async (_opts: { content: string; flags?: number }) => undefined),
  }
}

describe('/gamenight', () => {
  it('schedule inserts an enabled announcement with computed nextRunAt', async () => {
    const db = await testDb()
    const i = fakeInteraction('schedule', { message: 'Game night!', game: 'catan', first_in_hours: 2, every_days: 7 })
    await gamenightCommand.execute(i as never, { db })
    const rows = await db.select().from(scheduledAnnouncements)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.message).toBe('Game night!')
    expect(rows[0]!.intervalDays).toBe(7)
    expect(rows[0]!.enabled).toBe(true)
    expect(rows[0]!.nextRunAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('list shows entries and cancel disables by id', async () => {
    const db = await testDb()
    const [a] = await db
      .insert(scheduledAnnouncements)
      .values({ guildId: 'g1', channelId: 'c1', gameSlug: null, message: 'Hi', nextRunAt: new Date(), intervalDays: 7 })
      .returning()
    const list = fakeInteraction('list')
    await gamenightCommand.execute(list as never, { db })
    expect(JSON.stringify(list.reply.mock.calls[0]![0])).toContain('Hi')
    const cancel = fakeInteraction('cancel', { id: a!.id })
    await gamenightCommand.execute(cancel as never, { db })
    const rows = await db.select().from(scheduledAnnouncements)
    expect(rows[0]!.enabled).toBe(false)
  })
})

describe('/gamenight wakes the scheduler', () => {
  it('schedule and cancel both nudge the scheduler so the new time is picked up at once', async () => {
    const db = await testDb()
    const wake = vi.fn()
    await gamenightCommand.execute(fakeInteraction('schedule', { message: 'Go', first_in_hours: 1 }) as never, { db, wake })
    expect(wake).toHaveBeenCalledTimes(1)
    const [row] = await db.select().from(scheduledAnnouncements)
    await gamenightCommand.execute(fakeInteraction('cancel', { id: row!.id }) as never, { db, wake })
    expect(wake).toHaveBeenCalledTimes(2)
  })
})
