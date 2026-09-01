import { randomBytes } from 'node:crypto'

/** Opaque url-safe token, e.g. `st_...` (seats) or `cb_...` (result callbacks). */
export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString('base64url')}`
}
