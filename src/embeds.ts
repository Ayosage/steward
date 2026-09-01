import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js'
import type { MatchRow, SeatRow } from './db/schema.js'
import type { GameDef } from './games.js'

export function matchEmbed(game: GameDef, match: MatchRow): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`${game.name} match ready`)
    .setDescription('Click **Join** below to get your personal seat link.')
    .addFields(
      { name: 'Room code', value: `\`${match.code}\``, inline: true },
      { name: 'Seats', value: `${match.players} (${match.bots} bot${match.bots === 1 ? '' : 's'})`, inline: true },
    )
    .setColor(0x2c6e8f)
  if (match.expiresAt) {
    const expires = Math.floor(match.expiresAt.getTime() / 1000)
    embed.addFields({ name: 'Link expires', value: `<t:${expires}:R> if nobody joins`, inline: true })
  }
  return embed
}

export function joinRow(matchId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`join:${matchId}`).setLabel('Join').setStyle(ButtonStyle.Primary),
  )
}

/** Free-form per-game extras blob, rendered compactly and never aggregated. */
function statsLine(stats: unknown): string {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return ''
  const parts = Object.entries(stats as Record<string, unknown>).map(([k, v]) => (v === true ? k : `${k}: ${String(v)}`))
  return parts.length ? ` — ${parts.join(' · ')}` : ''
}

export function resultEmbed(game: GameDef, match: MatchRow, seatRows: SeatRow[]): EmbedBuilder {
  const ordered = [...seatRows].sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99))
  const lines = ordered.map((s) => {
    const name = s.discordUserId ? `<@${s.discordUserId}>` : (s.displayName ?? 'Anonymous')
    const place = s.placement != null ? `${s.placement}. ` : ''
    return `${place}${s.winner ? '🏆 ' : ''}${name}${statsLine(s.stats)}`
  })
  const completed = match.status === 'completed'
  return new EmbedBuilder()
    .setTitle(`${game.name} — match ${completed ? 'complete' : 'abandoned'}`)
    .setDescription(lines.join('\n') || 'No seat results reported.')
    .addFields({ name: 'Room code', value: `\`${match.code}\``, inline: true })
    .setColor(completed ? 0x3f9e58 : 0x8f6e2c)
}
