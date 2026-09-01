import { MessageFlags, type ButtonInteraction } from 'discord.js'
import { eq } from 'drizzle-orm'
import { getDb, type Db } from '../db/index.js'
import { matches } from '../db/schema.js'
import { MatchClosedError, MatchFullError, mintSeat } from '../matches.js'

export function isJoinButton(customId: string): boolean {
  return customId.startsWith('join:')
}

export async function handleJoinButton(interaction: ButtonInteraction, db: Db = getDb()): Promise<void> {
  const matchId = Number(interaction.customId.slice('join:'.length))
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId))
  if (!match) {
    await interaction.reply({ content: 'This match no longer exists.', flags: MessageFlags.Ephemeral })
    return
  }
  try {
    const minted = await mintSeat(db, match, { id: interaction.user.id, displayName: interaction.user.displayName })
    const lead = minted.reused ? 'Your seat link (already claimed):' : 'Your personal seat link:'
    await interaction.reply({ content: `${lead}\n${minted.personalUrl}`, flags: MessageFlags.Ephemeral })
  } catch (e) {
    const content =
      e instanceof MatchClosedError
        ? 'This match is closed.'
        : e instanceof MatchFullError
          ? 'All seats are taken.'
          : 'Could not mint your seat link.'
    await interaction.reply({ content, flags: MessageFlags.Ephemeral })
  }
}
