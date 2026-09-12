import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { defaultPlayDeps, runPlay, type PlayDeps } from './play.js'

/** Alias for `/play game:wordy`. */
export const wordyCommand = {
  data: new SlashCommandBuilder().setName('wordy').setDescription('Launch a Wordy Champions match; you host it in the browser'),

  async execute(interaction: ChatInputCommandInteraction, deps: PlayDeps = defaultPlayDeps()): Promise<void> {
    await runPlay(interaction, 'wordy', deps)
  },
}
