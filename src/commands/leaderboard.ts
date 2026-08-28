import { EmbedBuilder, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js'
import { getDb, type Db } from '../db/index.js'
import { games, getGame } from '../games.js'
import { leaderboard } from '../stats.js'

export interface LeaderboardDeps {
  db: Db
}

export const leaderboardCommand = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top players for a game in this server')
    .addStringOption((o) => o.setName('game').setDescription('Which game').setRequired(true).setAutocomplete(true)),

  async execute(interaction: ChatInputCommandInteraction, deps: LeaderboardDeps = { db: getDb() }): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Leaderboards are per-server — use this in a server channel.' })
      return
    }
    const slug = interaction.options.getString('game', true)
    const game = getGame(slug)
    if (!game) {
      await interaction.reply({ content: `Unknown game \`${slug}\` — see /games.` })
      return
    }
    const rows = await leaderboard(deps.db, interaction.guildId, slug)
    if (rows.length === 0) {
      await interaction.reply({ content: `No completed ${game.name} games yet.` })
      return
    }
    const lines = rows.map(
      (r, i) => `${i + 1}. <@${r.discordUserId}> — ${r.wins} win${r.wins === 1 ? '' : 's'} / ${r.games} (${Math.round(r.winRate * 100)}%)`,
    )
    const embed = new EmbedBuilder().setTitle(`${game.name} — leaderboard`).setDescription(lines.join('\n')).setColor(0x2c6e8f)
    await interaction.reply({ embeds: [embed] })
  },

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const q = String(interaction.options.getFocused()).toLowerCase()
    await interaction.respond(
      games.filter((g) => g.slug.includes(q) || g.name.toLowerCase().includes(q)).slice(0, 25).map((g) => ({ name: g.name, value: g.slug })),
    )
  },
}
