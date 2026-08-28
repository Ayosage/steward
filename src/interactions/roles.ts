import { MessageFlags, type GuildMember, type StringSelectMenuInteraction } from 'discord.js'
import { and, eq } from 'drizzle-orm'
import { getDb, type Db } from '../db/index.js'
import { gameRoles } from '../db/schema.js'
import { getGame } from '../games.js'

export function isRoleSelect(customId: string): boolean {
  return customId === 'roles:pick'
}

export async function handleRoleSelect(interaction: StringSelectMenuInteraction, db: Db = getDb()): Promise<void> {
  const slug = interaction.values[0]
  if (!slug || !interaction.guildId || !interaction.member) return
  const [row] = await db
    .select()
    .from(gameRoles)
    .where(and(eq(gameRoles.guildId, interaction.guildId), eq(gameRoles.gameSlug, slug)))
  if (!row) {
    await interaction.reply({ content: 'No role is configured for that game — ask an admin to run /roles setup.', flags: MessageFlags.Ephemeral })
    return
  }
  const member = interaction.member as GuildMember
  const name = getGame(slug)?.name ?? slug
  try {
    if (member.roles.cache.has(row.roleId)) {
      await member.roles.remove(row.roleId)
      await interaction.reply({ content: `Removed the **${name}** role.`, flags: MessageFlags.Ephemeral })
    } else {
      await member.roles.add(row.roleId)
      await interaction.reply({ content: `Gave you the **${name}** role.`, flags: MessageFlags.Ephemeral })
    }
  } catch (e) {
    console.error(`[roles] toggle failed for role ${row.roleId}:`, e)
    await interaction.reply({ content: 'Could not change that role — it may have been deleted, or the bot lacks permission.', flags: MessageFlags.Ephemeral })
  }
}
