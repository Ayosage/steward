import type { Client } from 'discord.js'
import { eq } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { guildConfig, type MatchRow, type SeatRow } from './db/schema.js'
import { resultEmbed } from './embeds.js'
import { getGame } from './games.js'

/** Posts the result embed to the launch channel, mirrored to the match-log if configured. */
export function makeResultPoster(client: Pick<Client, 'channels'>, db: Db) {
  return async (match: MatchRow, seatRows: SeatRow[]): Promise<void> => {
    const game = getGame(match.gameSlug)
    if (!game) {
      console.error(`[results] match ${match.id} references unknown game ${match.gameSlug}`)
      return
    }
    const embed = resultEmbed(game, match, seatRows)
    const [cfg] = await db.select().from(guildConfig).where(eq(guildConfig.guildId, match.guildId))
    const targets = [match.channelId]
    if (cfg?.matchLogChannelId && cfg.matchLogChannelId !== match.channelId) targets.push(cfg.matchLogChannelId)
    for (const channelId of targets) {
      try {
        const channel = await client.channels.fetch(channelId)
        if (channel?.isSendable()) await channel.send({ embeds: [embed] })
      } catch (e) {
        console.error(`[results] could not post to channel ${channelId}:`, e)
      }
    }
  }
}
