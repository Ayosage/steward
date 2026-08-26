/**
 * Thin client for Meridian's create-match endpoint.
 * Contract: webdev/meridian/docs/DISCORD-LAUNCH.md (v0).
 */
export interface MeridianEnv {
  apiUrl: string
  launchToken: string
}

export interface LaunchRequest {
  players: number
  bots: number
  seatNames?: string[]
}

export interface LaunchedMatch {
  code: string
  joinUrl: string
  expiresAt: string
}

export class MeridianLaunchError extends Error {}

export async function createMeridianMatch(
  request: LaunchRequest,
  env: MeridianEnv,
  fetchFn: typeof fetch = fetch,
): Promise<LaunchedMatch> {
  let res: Response
  try {
    res = await fetchFn(`${env.apiUrl}/matches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.launchToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
  } catch (e) {
    throw new MeridianLaunchError(`could not reach the game server: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status !== 201) {
    let detail = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) detail = body.error
    } catch {
      // non-JSON error body: keep the status text
    }
    throw new MeridianLaunchError(detail)
  }
  return (await res.json()) as LaunchedMatch
}
