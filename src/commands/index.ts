import type { ChatInputCommandInteraction, SlashCommandOptionsOnlyBuilder } from 'discord.js'
import { catanCommand } from './catan.js'

export interface Command {
  data: SlashCommandOptionsOnlyBuilder
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>
}

/** All slash commands, keyed by name. New commands register here. */
export const commands: ReadonlyMap<string, Command> = new Map<string, Command>([
  [catanCommand.data.name, catanCommand],
])
