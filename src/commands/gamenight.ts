import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { and, eq } from 'drizzle-orm'
import { getDb, type Db } from '../db/index.js'
import { scheduledAnnouncements } from '../db/schema.js'

export interface GamenightDeps {
  db: Db
}

export const gamenightCommand = {
  data: new SlashCommandBuilder()
    .setName('gamenight')
    .setDescription('Scheduled game-night announcements')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('schedule')
        .setDescription('Schedule a recurring announcement')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Where to post').addChannelTypes(ChannelType.GuildText).setRequired(true),
        )
        .addStringOption((o) => o.setName('message').setDescription('Announcement text').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('first_in_hours').setDescription('Hours until the first post (default 1)').setMinValue(0).setMaxValue(720),
        )
        .addIntegerOption((o) =>
          o.setName('every_days').setDescription('Repeat every N days (default 7)').setMinValue(1).setMaxValue(90),
        )
        .addStringOption((o) => o.setName('game').setDescription('Game whose role gets pinged')),
    )
    .addSubcommand((sc) => sc.setName('list').setDescription('List scheduled announcements'))
    .addSubcommand((sc) =>
      sc
        .setName('cancel')
        .setDescription('Cancel a scheduled announcement')
        .addIntegerOption((o) => o.setName('id').setDescription('Announcement id (see /gamenight list)').setRequired(true)),
    ),

  async execute(interaction: ChatInputCommandInteraction, deps: GamenightDeps = { db: getDb() }): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral })
      return
    }
    const sub = interaction.options.getSubcommand()
    if (sub === 'schedule') {
      const channel = interaction.options.getChannel('channel', true)
      const message = interaction.options.getString('message', true)
      const firstInHours = interaction.options.getInteger('first_in_hours') ?? 1
      const everyDays = interaction.options.getInteger('every_days') ?? 7
      const gameSlug = interaction.options.getString('game')
      const nextRunAt = new Date(Date.now() + firstInHours * 3600_000)
      const [row] = await deps.db
        .insert(scheduledAnnouncements)
        .values({ guildId: interaction.guildId, channelId: channel.id, gameSlug, message, nextRunAt, intervalDays: everyDays })
        .returning()
      await interaction.reply({
        content: `Scheduled #${row!.id}: first post <t:${Math.floor(nextRunAt.getTime() / 1000)}:R>, then every ${everyDays} day${everyDays === 1 ? '' : 's'}.`,
        flags: MessageFlags.Ephemeral,
      })
    } else if (sub === 'list') {
      const rows = await deps.db
        .select()
        .from(scheduledAnnouncements)
        .where(and(eq(scheduledAnnouncements.guildId, interaction.guildId), eq(scheduledAnnouncements.enabled, true)))
      const lines = rows.map(
        (r) => `**#${r.id}** <#${r.channelId}> every ${r.intervalDays}d, next <t:${Math.floor(r.nextRunAt.getTime() / 1000)}:R> — ${r.message}`,
      )
      await interaction.reply({ content: lines.join('\n') || 'No scheduled announcements.', flags: MessageFlags.Ephemeral })
    } else if (sub === 'cancel') {
      const id = interaction.options.getInteger('id', true)
      const updated = await deps.db
        .update(scheduledAnnouncements)
        .set({ enabled: false })
        .where(and(eq(scheduledAnnouncements.id, id), eq(scheduledAnnouncements.guildId, interaction.guildId)))
        .returning()
      await interaction.reply({
        content: updated.length > 0 ? `Cancelled announcement #${id}.` : `No announcement #${id} in this server.`,
        flags: MessageFlags.Ephemeral,
      })
    }
  },
}
