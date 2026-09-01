import { Routes } from 'discord.js'
import { commands } from './commands/index.js'

// Minimal slice of discord.js REST so callers can pass client.rest or a standalone REST.
export type RestLike = {
  put(route: string, options: { body: unknown }): Promise<unknown>
}

// Guild-scoped registration is instant; global propagates to every guild the
// bot is installed in (including future installs), so no per-guild bookkeeping.
export async function registerCommands(rest: RestLike, appId: string, guildId?: string) {
  const body = [...commands.values()].map((c) => c.data.toJSON())
  const route = guildId ? Routes.applicationGuildCommands(appId, guildId) : Routes.applicationCommands(appId)
  const registered = (await rest.put(route, { body })) as unknown[]
  return { count: registered.length, scope: guildId ? `guild ${guildId}` : 'global' }
}
