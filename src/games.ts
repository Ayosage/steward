/** Static game registry: games enter the library when we build one (a code change anyway). */
export interface GameDef {
  slug: string
  name: string
  launchUrl: string
  tokenEnvVar: string
  minPlayers: number
  maxPlayers: number
  maxBots: number
  defaultPlayers: number
}

export const games: readonly GameDef[] = [
  {
    slug: 'catan',
    name: 'CATAN (Meridian)',
    launchUrl: process.env.MERIDIAN_API_URL ?? 'http://localhost:2567',
    tokenEnvVar: 'MERIDIAN_LAUNCH_TOKEN',
    minPlayers: 3,
    maxPlayers: 8,
    maxBots: 7,
    defaultPlayers: 4,
  },
]

export function getGame(slug: string): GameDef | undefined {
  return games.find((g) => g.slug === slug)
}

/** Returns a user-facing error message, or null when the launch parameters are valid. */
export function validateLaunch(game: GameDef, players: number, bots: number): string | null {
  if (players < game.minPlayers || players > game.maxPlayers)
    return `players must be ${game.minPlayers}..${game.maxPlayers}`
  const maxBots = Math.min(game.maxBots, players - 1)
  if (bots < 0 || bots > maxBots) return `bots must be 0..${maxBots}`
  return null
}
