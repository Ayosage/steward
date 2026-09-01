import { describe, expect, it, vi } from 'vitest'
import { matches, seats } from '../src/db/schema.js'
import { handleJoinButton, isJoinButton } from '../src/interactions/join.js'
import { testDb } from './helpers/db.js'

async function seed(db: Awaited<ReturnType<typeof testDb>>, status = 'pending' as const) {
  const [m] = await db
    .insert(matches)
    .values({
      guildId: 'g1', channelId: 'c1', gameSlug: 'catan', code: 'ABCD',
      joinUrl: 'http://play.example/?join=ABCD', callbackToken: 'cb_x',
      createdByDiscordId: 'u1', players: 4, bots: 0, status,
    })
    .returning()
  return m!
}

function fakeButton(customId: string) {
  return {
    customId,
    user: { id: 'u2', displayName: 'Alice' },
    reply: vi.fn(async (_opts: { content: string; flags?: number }) => undefined),
  }
}

describe('join button', () => {
  it('recognizes only join customIds', () => {
    expect(isJoinButton('join:7')).toBe(true)
    expect(isJoinButton('roles:pick')).toBe(false)
  })

  it('replies ephemerally with a personal seat link', async () => {
    const db = await testDb()
    const m = await seed(db)
    const i = fakeButton(`join:${m.id}`)
    await handleJoinButton(i as never, db)
    const reply = i.reply.mock.calls[0]![0]
    expect(reply.content).toContain('seat=st_')
    expect(reply.flags).toBeTruthy()
    expect(await db.select().from(seats)).toHaveLength(1)
  })

  it('tells the user when the match is closed', async () => {
    const db = await testDb()
    const m = await seed(db, 'expired' as never)
    const i = fakeButton(`join:${m.id}`)
    await handleJoinButton(i as never, db)
    expect(i.reply.mock.calls[0]![0].content).toContain('closed')
  })

  it('handles a vanished match without throwing', async () => {
    const db = await testDb()
    const i = fakeButton('join:999')
    await handleJoinButton(i as never, db)
    expect(i.reply.mock.calls[0]![0].content).toContain('no longer exists')
  })
})
