import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { getDb, type Db } from '../db/index.js'
import { joinRow, matchEmbed } from '../embeds.js'
import { GameLaunchError } from '../game-client.js'
import { games, getGame, validateLaunch } from '../games.js'
import { launchMatch } from '../matches.js'

export interface PlayDeps {
  db: Db
  launch: typeof launchMatch
  publicBaseUrl: string
}

export function defaultPlayDeps(): PlayDeps {
  return {
    db: getDb(),
    launch: launchMatch,
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787',
  }
}

/** Shared launch path for /play and per-game aliases like /catan. */
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
  const players = interaction.options.getInteger('players') ?? game.defaultPlayers
  const bots = interaction.options.getInteger('bots') ?? 0
  const invalid = validateLaunch(game, players, bots)
  if (invalid) {
    await interaction.reply({ content: `Could not launch: ${invalid}`, flags: MessageFlags.Ephemeral })
    return
  }
  await interaction.deferReply()
  try {
    const match = await deps.launch({
      db: deps.db,
      game,
      players,
      bots,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      createdByDiscordId: interaction.user.id,
      publicBaseUrl: deps.publicBaseUrl,
    })
    await interaction.editReply({ embeds: [matchEmbed(game, match)], components: [joinRow(match.id)] })
  } catch (e) {
    const reason = e instanceof GameLaunchError ? e.message : 'unexpected launch failure'
    await interaction.editReply({ content: `Could not launch the match: ${reason}` })
  }
}

export const playCommand = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Launch a game from the library')
    .addStringOption((o) => o.setName('game').setDescription('Which game').setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName('players').setDescription('Number of seats (per-game bounds)'))
    .addIntegerOption((o) => o.setName('bots').setDescription('Bot seats (default 0)')),

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
