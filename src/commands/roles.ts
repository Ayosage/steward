import {
  ActionRowBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { getDb, type Db } from '../db/index.js'
import { gameRoles } from '../db/schema.js'
import { games } from '../games.js'

export interface RolesDeps {
  db: Db
}

export const rolesCommand = {
  data: new SlashCommandBuilder()
    .setName('roles')
    .setDescription('Game role self-assignment')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) => sc.setName('setup').setDescription('Create game roles and post the self-assign menu')),

  async execute(interaction: ChatInputCommandInteraction, deps: RolesDeps = { db: getDb() }): Promise<void> {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral })
      return
    }
    for (const game of games) {
      const existing = interaction.guild.roles.cache.find((r) => r.name === game.name)
      const role = existing ?? (await interaction.guild.roles.create({ name: game.name, mentionable: true }))
      await deps.db
        .insert(gameRoles)
        .values({ guildId: interaction.guildId, gameSlug: game.slug, roleId: role.id })
        .onConflictDoUpdate({ target: [gameRoles.guildId, gameRoles.gameSlug], set: { roleId: role.id } })
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId('roles:pick')
      .setPlaceholder('Pick a game to toggle its role')
      .addOptions(games.map((g) => ({ label: g.name, value: g.slug })))
    await interaction.reply({
      content: 'Grab a game role to get pinged for game nights:',
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    })
  },
}
