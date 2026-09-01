import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { defaultPlayDeps, runPlay, type PlayDeps } from './play.js'

/** Alias for `/play game:catan` — kept for muscle memory. */
export const catanCommand = {
  data: new SlashCommandBuilder().setName('catan').setDescription('Open a CATAN (Meridian) lobby'),

  async execute(interaction: ChatInputCommandInteraction, deps: PlayDeps = defaultPlayDeps()): Promise<void> {
    await runPlay(interaction, 'catan', deps)
  },
}
