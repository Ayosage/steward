import 'dotenv/config'
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js'
import { commands } from './commands/index.js'

const token = process.env.DISCORD_TOKEN
if (!token) {
  console.error('DISCORD_TOKEN is not set (see .env.example)')
  process.exit(1)
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] })

client.once(Events.ClientReady, (c) => {
  console.log(`steward ready as ${c.user.tag}`)
})

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return
  const command = commands.get(interaction.commandName)
  if (!command) return
  try {
    await command.execute(interaction)
  } catch (e) {
    console.error(`command /${interaction.commandName} failed:`, e)
    const content = 'Something went wrong running that command.'
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content }).catch(() => undefined)
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined)
  }
})

void client.login(token)
