import { sql } from 'drizzle-orm'
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const matches = pgTable('matches', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  channelId: text('channel_id').notNull(), // result embed target (launch channel)
  gameSlug: text('game_slug').notNull(),
  code: text('code').notNull(),
  joinUrl: text('join_url').notNull(),
  callbackToken: text('callback_token').notNull().unique(),
  status: text('status', { enum: ['pending', 'active', 'completed', 'abandoned', 'expired'] })
    .notNull()
    .default('pending'),
  createdByDiscordId: text('created_by_discord_id').notNull(),
  players: integer('players').notNull(),
  bots: integer('bots').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
})

export const seats = pgTable(
  'seats',
  {
    id: serial('id').primaryKey(),
    matchId: integer('match_id')
      .notNull()
      .references(() => matches.id),
    seatToken: text('seat_token').notNull().unique(),
    discordUserId: text('discord_user_id'), // null = anonymous seat
    displayName: text('display_name'),
    placement: integer('placement'),
    winner: boolean('winner'),
    stats: jsonb('stats'),
  },
  (t) => [
    // one seat per discord user per match (anonymous seats exempt)
    uniqueIndex('seats_match_user_unique')
      .on(t.matchId, t.discordUserId)
      .where(sql`${t.discordUserId} is not null`),
  ],
)

export const guildConfig = pgTable('guild_config', {
  guildId: text('guild_id').primaryKey(),
  matchLogChannelId: text('match_log_channel_id'),
})

export const gameRoles = pgTable(
  'game_roles',
  {
    guildId: text('guild_id').notNull(),
    gameSlug: text('game_slug').notNull(),
    roleId: text('role_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.gameSlug] })],
)

export const scheduledAnnouncements = pgTable('scheduled_announcements', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  channelId: text('channel_id').notNull(),
  gameSlug: text('game_slug'), // null = generic announcement, no role ping
  message: text('message').notNull(),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
  intervalDays: integer('interval_days').notNull(),
  enabled: boolean('enabled').notNull().default(true),
})

export type MatchRow = typeof matches.$inferSelect
export type SeatRow = typeof seats.$inferSelect
export type AnnouncementRow = typeof scheduledAnnouncements.$inferSelect
