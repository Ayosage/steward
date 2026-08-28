import type { Db } from './db/index.js'
import { matches, type MatchRow } from './db/schema.js'
import { createGameMatch } from './game-client.js'
import type { GameDef } from './games.js'
import { newToken } from './tokens.js'

export interface LaunchMatchArgs {
  db: Db
  game: GameDef
  players: number
  bots: number
  guildId: string
  channelId: string
  createdByDiscordId: string
  publicBaseUrl: string
  createMatch?: typeof createGameMatch
}

/** Launch via the game adapter; the match row exists only after the game's 201. */
export async function launchMatch(args: LaunchMatchArgs): Promise<MatchRow> {
  const create = args.createMatch ?? createGameMatch
  const callbackToken = newToken('cb')
  const launched = await create(args.game, {
    players: args.players,
    bots: args.bots,
    callback: { url: `${args.publicBaseUrl}/webhooks/results`, token: callbackToken },
  })
  const [row] = await args.db
    .insert(matches)
    .values({
      guildId: args.guildId,
      channelId: args.channelId,
      gameSlug: args.game.slug,
      code: launched.code,
      joinUrl: launched.joinUrl,
      callbackToken,
      createdByDiscordId: args.createdByDiscordId,
      players: args.players,
      bots: args.bots,
      expiresAt: new Date(launched.expiresAt),
    })
    .returning()
  return row!
}
