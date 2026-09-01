import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { eq } from 'drizzle-orm'
import { getDb, type Db } from '../db/index.js'
import { lobbies } from '../db/schema.js'
import { lobbyEmbed, lobbyRows } from '../embeds.js'
import { games, getGame } from '../games.js'
import { createLobby } from '../lobbies.js'

export interface PlayDeps {
  db: Db
}

export function defaultPlayDeps(): PlayDeps {
  return { db: getDb() }
}

/** Shared lobby-open path for /play and per-game aliases like /catan. */
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
  const view = await createLobby(deps.db, {
    game,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    host: { id: interaction.user.id, displayName: interaction.user.displayName },
  })
  const message = await interaction.reply({
    embeds: [lobbyEmbed(game, view.lobby, view.members)],
    components: lobbyRows(view.lobby.id),
    fetchReply: true,
  })
  await deps.db.update(lobbies).set({ messageId: message.id }).where(eq(lobbies.id, view.lobby.id))
}

export const playCommand = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Open a game lobby from the library')
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
