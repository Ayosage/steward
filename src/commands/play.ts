import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { getDb, type Db } from '../db/index.js'
import { joinRow, matchEmbed } from '../embeds.js'
import { GameLaunchError } from '../game-client.js'
import { games, getGame } from '../games.js'
import { launchMatch, type LaunchMatchArgs, type LaunchedMatch } from '../matches.js'

export interface PlayDeps {
  db: Db
  launch: (args: LaunchMatchArgs) => Promise<LaunchedMatch>
  publicBaseUrl: string
}

export function defaultPlayDeps(): PlayDeps {
  return { db: getDb(), launch: launchMatch, publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787' }
}

/**
 * Shared launch path for /play and per-game aliases like /catan: the match is
 * created on the game right away with the invoker as host. The channel gets
 * the Join embed; the host gets their own seat link privately. Table size,
 * bots and the start happen in the game's web lobby.
 */
export async function runPlay(
  interaction: ChatInputCommandInteraction,
  slug: string,
  deps: PlayDeps,
): Promise<void> {
  const game = getGame(slug)
  if (!game) {
    await interaction.reply({ content: `Unknown game \`${slug}\` — see /games.`, flags: MessageFlags.Ephemeral })
    return
  }
  if (!interaction.guildId) {
    await interaction.reply({ content: 'This command only works in a server channel.', flags: MessageFlags.Ephemeral })
    return
  }
  let launched: LaunchedMatch
  try {
    launched = await deps.launch({
      db: deps.db,
      game,
      players: game.defaultPlayers,
      bots: 0,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      host: { id: interaction.user.id, displayName: interaction.user.displayName },
      publicBaseUrl: deps.publicBaseUrl,
    })
  } catch (e) {
    const detail = e instanceof GameLaunchError ? e.message : 'unexpected error'
    await interaction.reply({ content: `Could not launch the match: ${detail}`, flags: MessageFlags.Ephemeral })
    return
  }
  await interaction.reply({ embeds: [matchEmbed(game, launched.match)], components: [joinRow(launched.match.id)] })
  await interaction.followUp({
    content: `You are the host. Open your seat link to set up the table and start the match:\n${launched.personalUrl}`,
    flags: MessageFlags.Ephemeral,
  })
}

export const playCommand = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Launch a match from the library; you host it in the browser')
    .addStringOption((o) => o.setName('game').setDescription('Which game').setRequired(true).setAutocomplete(true)),

  async execute(interaction: ChatInputCommandInteraction, deps: PlayDeps = defaultPlayDeps()): Promise<void> {
    await runPlay(interaction, interaction.options.getString('game', true), deps)
  },

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const q = String(interaction.options.getFocused()).toLowerCase()
    await interaction.respond(
      games
        .filter((g) => g.slug.includes(q) || g.name.toLowerCase().includes(q))
        .slice(0, 25)
        .map((g) => ({ name: g.name, value: g.slug })),
    )
  },
}
