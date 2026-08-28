import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { getDb, type Db } from '../db/index.js'
import { guildConfig } from '../db/schema.js'

export interface ConfigDeps {
  db: Db
}

export const configCommand = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Steward server configuration')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('match-log')
        .setDescription('Channel where every match result is archived')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Archive channel').addChannelTypes(ChannelType.GuildText).setRequired(true),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction, deps: ConfigDeps = { db: getDb() }): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral })
      return
    }
    const channel = interaction.options.getChannel('channel', true)
    await deps.db
      .insert(guildConfig)
      .values({ guildId: interaction.guildId, matchLogChannelId: channel.id })
      .onConflictDoUpdate({ target: guildConfig.guildId, set: { matchLogChannelId: channel.id } })
    await interaction.reply({ content: `Match results will be archived in ${channel.toString()}.`, flags: MessageFlags.Ephemeral })
  },
}
