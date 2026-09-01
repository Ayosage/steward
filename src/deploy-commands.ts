import 'dotenv/config'
import { REST } from 'discord.js'
import { registerCommands } from './register-commands.js'

// Standalone registration without starting the bot. Normally unnecessary:
// index.ts registers on every startup. Useful for pre-registering commands
// or re-syncing while the bot is down.
const token = process.env.DISCORD_TOKEN
const appId = process.env.DISCORD_APP_ID

if (!token || !appId) {
  console.error('DISCORD_TOKEN and DISCORD_APP_ID must be set (see .env.example)')
  process.exit(1)
}

const { count, scope } = await registerCommands(new REST().setToken(token), appId, process.env.DISCORD_GUILD_ID || undefined)
console.log(`registered ${count} command(s) (${scope})`)
