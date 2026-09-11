import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { defaultPlayDeps, runPlay, type PlayDeps } from './play.js'

/** Alias for `/play game:catan` — kept for muscle memory. */
export const catanCommand = {
  data: new SlashCommandBuilder().setName('catan').setDescription('Launch a CATAN (Meridian) match; you host it in the browser'),

  async execute(interaction: ChatInputCommandInteraction, deps: PlayDeps = defaultPlayDeps()): Promise<void> {
    await runPlay(interaction, 'catan', deps)
  },
}
