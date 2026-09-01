import 'dotenv/config'
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js'
import { commands } from './commands/index.js'
import { getDb } from './db/index.js'
import { handleJoinButton, isJoinButton } from './interactions/join.js'
import { handleRoleSelect, isRoleSelect } from './interactions/roles.js'
import { makeResultPoster } from './result-poster.js'
import { startScheduler } from './scheduler.js'
import { createWebhookServer } from './webhook-server.js'

const token = process.env.DISCORD_TOKEN
if (!token) {
  console.error('DISCORD_TOKEN is not set (see .env.example)')
  process.exit(1)
}

const db = getDb()
const client = new Client({ intents: [GatewayIntentBits.Guilds] })

client.once(Events.ClientReady, (c) => {
  console.log(`steward ready as ${c.user.tag}`)
})

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await commands.get(interaction.commandName)?.execute(interaction)
    } else if (interaction.isAutocomplete()) {
      await commands.get(interaction.commandName)?.autocomplete?.(interaction)
    } else if (interaction.isButton() && isJoinButton(interaction.customId)) {
      await handleJoinButton(interaction)
    } else if (interaction.isStringSelectMenu() && isRoleSelect(interaction.customId)) {
      await handleRoleSelect(interaction)
    }
  } catch (e) {
    console.error('interaction failed:', e)
    if (interaction.isRepliable()) {
      const content = 'Something went wrong running that command.'
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content }).catch(() => undefined)
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined)
    }
  }
})

const webhook = createWebhookServer({ db, onResult: makeResultPoster(client, db) })
const port = Number(process.env.WEBHOOK_PORT ?? 8787)
webhook.listen(port, () => console.log(`result webhooks on :${port}`))

startScheduler({
  db,
  post: async (channelId, content) => {
    const channel = await client.channels.fetch(channelId)
    if (channel?.isSendable()) await channel.send({ content })
  },
})

void client.login(token)
