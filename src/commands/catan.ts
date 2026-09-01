import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { defaultPlayDeps, runPlay, type PlayDeps } from './play.js'

/** Alias for `/play game:catan` — kept for muscle memory. */
export const catanCommand = {
  data: new SlashCommandBuilder()
    .setName('catan')
    .setDescription('Launch a CATAN (Meridian) match')
    .addIntegerOption((o) => o.setName('players').setDescription('Seats, 3-8 (default 4)').setMinValue(3).setMaxValue(8))
    .addIntegerOption((o) => o.setName('bots').setDescription('Bot seats, 0 to players-1 (default 0)').setMinValue(0).setMaxValue(7)),

  async execute(interaction: ChatInputCommandInteraction, deps: PlayDeps = defaultPlayDeps()): Promise<void> {
    await runPlay(interaction, 'catan', deps)
  },
}
