import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js'
import { catanCommand } from './catan.js'
import { gamesCommand } from './games.js'
import { leaderboardCommand } from './leaderboard.js'
import { playCommand } from './play.js'
import { statsCommand } from './stats.js'

export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody }
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>
}

/** All slash commands, keyed by name. New commands register here. */
export const commands: ReadonlyMap<string, Command> = new Map<string, Command>(
  [playCommand, catanCommand, gamesCommand, statsCommand, leaderboardCommand].map((c) => [c.data.name, c] as const),
)
