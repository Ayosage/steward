import { EmbedBuilder, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js'
import { getDb, type Db } from '../db/index.js'
import { games, getGame } from '../games.js'
import { playerStats } from '../stats.js'

export interface StatsDeps {
  db: Db
}

const pct = (r: number): string => `${Math.round(r * 100)}%`

export const statsCommand = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Game stats for a player in this server')
    .addUserOption((o) => o.setName('user').setDescription('Whose stats (default: you)'))
    .addStringOption((o) => o.setName('game').setDescription('Limit to one game').setAutocomplete(true)),

  async execute(interaction: ChatInputCommandInteraction, deps: StatsDeps = { db: getDb() }): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Stats are per-server — use this in a server channel.' })
      return
    }
    const target = interaction.options.getUser('user') ?? interaction.user
    const slug = interaction.options.getString('game') ?? undefined
    const rows = await playerStats(deps.db, interaction.guildId, target.id, slug)
    if (rows.length === 0) {
      await interaction.reply({ content: `No completed games for <@${target.id}> yet.` })
      return
    }
    const lines = rows.map((r) => {
      const name = getGame(r.gameSlug)?.name ?? r.gameSlug
      return `**${name}** — ${r.games} game${r.games === 1 ? '' : 's'} · ${r.wins} win${r.wins === 1 ? '' : 's'} · ${pct(r.winRate)}`
    })
    const embed = new EmbedBuilder().setTitle(`Stats — ${target.displayName}`).setDescription(lines.join('\n')).setColor(0x2c6e8f)
    await interaction.reply({ embeds: [embed] })
  },

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const q = String(interaction.options.getFocused()).toLowerCase()
    await interaction.respond(
      games.filter((g) => g.slug.includes(q) || g.name.toLowerCase().includes(q)).slice(0, 25).map((g) => ({ name: g.name, value: g.slug })),
    )
  },
}
