import {
  ActionRowBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js'
import { getDb, type Db } from '../db/index.js'
import { joinRow, lobbyClosedEmbed, lobbyEmbed, lobbyRows, matchEmbed } from '../embeds.js'
import { GameLaunchError } from '../game-client.js'
import { getGame, type GameDef } from '../games.js'
import {
  HostCannotLeaveError,
  LobbyClosedError,
  LobbyFullError,
  NotHostError,
  NotMemberError,
  StartInvalidError,
  cancelLobby,
  getLobbyView,
  setBots,
  startLobby,
  toggleMember,
  transferHost,
  type LobbyView,
  type StartDeps,
} from '../lobbies.js'
import { launchMatch } from '../matches.js'

export interface LobbyDeps {
  db: Db
  start: StartDeps
}

export function defaultLobbyDeps(): LobbyDeps {
  return {
    db: getDb(),
    start: { launch: launchMatch, publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787' },
  }
}

const BUTTON_RE = /^lobby:(\d+):(join|botadd|botsub|start|givehost|cancel)$/
const HOST_SELECT_RE = /^lobbyhost:(\d+)$/

export function isLobbyButton(customId: string): boolean {
  return BUTTON_RE.test(customId)
}

export function isLobbyHostSelect(customId: string): boolean {
  return HOST_SELECT_RE.test(customId)
}

function userMessage(e: unknown): string | null {
  if (e instanceof LobbyClosedError) return 'This lobby is closed.'
  if (e instanceof LobbyFullError) return 'All seats are taken.'
  if (e instanceof NotHostError) return 'Only the host can do that.'
  if (e instanceof NotMemberError) return 'They need to join the lobby first.'
  if (e instanceof HostCannotLeaveError) return 'You are the host — give host to someone else (or cancel) first.'
  if (e instanceof StartInvalidError) return `Cannot start: ${e.message}.`
  if (e instanceof GameLaunchError) return `Could not launch the match: ${e.message}`
  return null
}

function lobbyMessagePayload(game: GameDef, view: LobbyView) {
  return { embeds: [lobbyEmbed(game, view.lobby, view.members)], components: lobbyRows(view.lobby.id) }
}

export async function handleLobbyButton(
  interaction: ButtonInteraction,
  deps: LobbyDeps = defaultLobbyDeps(),
): Promise<void> {
  const [, idStr, action] = BUTTON_RE.exec(interaction.customId)!
  const lobbyId = Number(idStr)
  const view = await getLobbyView(deps.db, lobbyId)
  const game = view && getGame(view.lobby.gameSlug)
  if (!view || !game) {
    await interaction.reply({ content: 'This lobby no longer exists.', flags: MessageFlags.Ephemeral })
    return
  }
  const user = { id: interaction.user.id, displayName: interaction.user.displayName }
  try {
    switch (action) {
      case 'join': {
        const result = await toggleMember(deps.db, lobbyId, user, game)
        await interaction.update(lobbyMessagePayload(game, result))
        return
      }
      case 'botadd':
      case 'botsub': {
        const result = await setBots(deps.db, lobbyId, user.id, action === 'botadd' ? +1 : -1, game)
        await interaction.update(lobbyMessagePayload(game, result))
        return
      }
      case 'givehost': {
        if (view.lobby.hostDiscordId !== user.id) throw new NotHostError('only the host can do that')
        const options = view.members
          .filter((m) => m.discordUserId !== view.lobby.hostDiscordId)
          .map((m) => ({ label: m.displayName ?? m.discordUserId, value: m.discordUserId }))
        if (options.length === 0) {
          await interaction.reply({ content: 'Nobody else is in the lobby yet.', flags: MessageFlags.Ephemeral })
          return
        }
        const select = new StringSelectMenuBuilder()
          .setCustomId(`lobbyhost:${lobbyId}`)
          .setPlaceholder('Pick the new host')
          .addOptions(options.slice(0, 25))
        await interaction.reply({
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
          flags: MessageFlags.Ephemeral,
        })
        return
      }
      case 'cancel': {
        const result = await cancelLobby(deps.db, lobbyId, user.id)
        await interaction.update({ embeds: [lobbyClosedEmbed(game, 'cancelled')], components: [] })
        void result
        return
      }
      case 'start': {
        await interaction.deferUpdate()
        const started = await startLobby(deps.db, lobbyId, user.id, game, deps.start)
        await interaction.editReply({ embeds: [matchEmbed(game, started.match)], components: [joinRow(started.match.id)] })
        return
      }
    }
  } catch (e) {
    const content = userMessage(e)
    if (!content) throw e
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral })
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral })
    }
  }
}

export async function handleLobbyHostSelect(
  interaction: StringSelectMenuInteraction,
  deps: LobbyDeps = defaultLobbyDeps(),
): Promise<void> {
  const [, idStr] = HOST_SELECT_RE.exec(interaction.customId)!
  const lobbyId = Number(idStr)
  const newHostId = interaction.values[0]!
  try {
    const result = await transferHost(deps.db, lobbyId, interaction.user.id, newHostId)
    const game = getGame(result.lobby.gameSlug)
    // Refresh the lobby message so the crown moves; the select lives on an ephemeral reply.
    if (game && result.lobby.messageId) {
      const channel = await interaction.client.channels.fetch(result.lobby.channelId)
      if (channel?.isTextBased() && 'messages' in channel) {
        await channel.messages.edit(result.lobby.messageId, lobbyMessagePayload(game, result)).catch(() => undefined)
      }
    }
    await interaction.update({ content: `Host given to <@${newHostId}>.`, components: [] })
  } catch (e) {
    const content = userMessage(e)
    if (!content) throw e
    await interaction.update({ content, components: [] })
  }
}
