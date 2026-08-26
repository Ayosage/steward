import 'dotenv/config'
import { REST, Routes } from 'discord.js'
import { commands } from './commands/index.js'

const token = process.env.DISCORD_TOKEN
const appId = process.env.DISCORD_APP_ID
const guildId = process.env.DISCORD_GUILD_ID

if (!token || !appId) {
  console.error('DISCORD_TOKEN and DISCORD_APP_ID must be set (see .env.example)')
  process.exit(1)
}

const body = [...commands.values()].map((c) => c.data.toJSON())
const rest = new REST().setToken(token)

// Guild-scoped registration is instant; global takes up to an hour to propagate.
const route = guildId ? Routes.applicationGuildCommands(appId, guildId) : Routes.applicationCommands(appId)
const scope = guildId ? `guild ${guildId}` : 'global'

const registered = (await rest.put(route, { body })) as unknown[]
console.log(`registered ${registered.length} command(s) (${scope})`)
