import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { eq } from 'drizzle-orm'
import { getDb, type Db } from '../db/index.js'
import { gameRoles } from '../db/schema.js'
import { games } from '../games.js'

export interface GamesDeps {
  db: Db
}

export const gamesCommand = {
  data: new SlashCommandBuilder().setName('games').setDescription('List the game library'),

  async execute(interaction: ChatInputCommandInteraction, deps: GamesDeps = { db: getDb() }): Promise<void> {
    const roleRows = interaction.guildId
      ? await deps.db.select().from(gameRoles).where(eq(gameRoles.guildId, interaction.guildId))
      : []
    const lines = games.map((g) => {
      const role = roleRows.find((r) => r.gameSlug === g.slug)
      return `**${g.name}** (\`${g.slug}\`) — ${g.minPlayers}–${g.maxPlayers} players${role ? ` — <@&${role.roleId}>` : ''}`
    })
    await interaction.reply({ content: `**Game library**\n${lines.join('\n')}` })
  },
}
