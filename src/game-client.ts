/**
 * Generic Steward→game launch client. Contract: docs/GAME-ADAPTER.md (v1).
 */
import type { GameDef } from './games.js'

export interface LaunchCallback {
  url: string
  token: string
}

export interface LaunchBody {
  players: number
  bots: number
  callback: LaunchCallback
  /** The invoker's seat: the game reserves seat 0 (host) for whoever arrives with this token. */
  host?: { seatToken: string; displayName?: string }
}

export interface LaunchedMatch {
  code: string
  joinUrl: string
  expiresAt: string
}

export class GameLaunchError extends Error {}

export async function createGameMatch(
  game: GameDef,
  body: LaunchBody,
  fetchFn: typeof fetch = fetch,
): Promise<LaunchedMatch> {
  const token = process.env[game.tokenEnvVar] ?? ''
  let res: Response
  try {
    res = await fetchFn(`${game.launchUrl}/matches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new GameLaunchError(`could not reach the game server: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status !== 201) {
    let detail = `HTTP ${res.status}`
    try {
      const parsed = (await res.json()) as { error?: string }
      if (parsed.error) detail = parsed.error
    } catch {
      // non-JSON error body: keep the status text
    }
    if (res.status === 401) console.error(`[games] launch token rejected for ${game.slug} — check ${game.tokenEnvVar}`)
    throw new GameLaunchError(detail)
  }
  return (await res.json()) as LaunchedMatch
}
