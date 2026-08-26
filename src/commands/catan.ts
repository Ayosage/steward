import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { createMeridianMatch, MeridianLaunchError, type LaunchedMatch, type LaunchRequest } from '../meridian.js'

export interface CatanDeps {
  createMatch: (request: LaunchRequest) => Promise<LaunchedMatch>
}

function defaultDeps(): CatanDeps {
  return {
    createMatch: (request) =>
      createMeridianMatch(request, {
        apiUrl: process.env.MERIDIAN_API_URL ?? 'http://localhost:2567',
        launchToken: process.env.MERIDIAN_LAUNCH_TOKEN ?? '',
      }),
  }
}

export const catanCommand = {
  data: new SlashCommandBuilder()
    .setName('catan')
    .setDescription('Launch a Meridian match and post the join link')
    .addIntegerOption((o) =>
      o.setName('players').setDescription('Seats, 3-8 (default 4)').setMinValue(3).setMaxValue(8),
    )
    .addIntegerOption((o) =>
      o.setName('bots').setDescription('Bot seats, 0 to players-1 (default 0)').setMinValue(0).setMaxValue(7),
    ),

  async execute(interaction: ChatInputCommandInteraction, deps: CatanDeps = defaultDeps()): Promise<void> {
    const players = interaction.options.getInteger('players') ?? 4
    const bots = interaction.options.getInteger('bots') ?? 0
    await interaction.deferReply()
    try {
      const match = await deps.createMatch({ players, bots, seatNames: [interaction.user.displayName] })
      const expires = Math.floor(new Date(match.expiresAt).getTime() / 1000)
      const embed = new EmbedBuilder()
        .setTitle('Meridian match ready')
        .setDescription(`**[Click to take a seat](${match.joinUrl})**`)
        .addFields(
          { name: 'Room code', value: `\`${match.code}\``, inline: true },
          { name: 'Seats', value: `${players} (${bots} bot${bots === 1 ? '' : 's'})`, inline: true },
          { name: 'Link expires', value: `<t:${expires}:R> if nobody joins`, inline: true },
        )
        .setColor(0x2c6e8f)
      await interaction.editReply({ embeds: [embed] })
    } catch (e) {
      const reason = e instanceof MeridianLaunchError ? e.message : 'unexpected launch failure'
      await interaction.editReply({ content: `Could not launch the match: ${reason}` })
    }
  },
}
