# Steward Game-Adapter Contract (v1)

Any game implementing this HTTP contract can enter Steward's library via a
`src/games.ts` registry entry. Meridian's `DISCORD-LAUNCH.md` (v0) is
superseded by this document and keeps only Catan-specific notes.

## 1. Launch — Steward → game

```
POST <game.launchUrl>/matches
Authorization: Bearer <per-game LAUNCH_TOKEN>

{
  "players": 4,
  "bots": 0,
  "seats": [{ "seatToken": "st_...", "displayName": "Alice" }],   // optional
  "callback": { "url": "https://<steward>/webhooks/results", "token": "cb_..." }
}
```

Response unchanged from v0: `201` with `{ code, joinUrl, expiresAt }`;
errors `401` / `422` / `503`. `callback` is minted per match: a random
token Steward later uses to authenticate the result webhook. No shared
secrets, no HMAC; the game echoes what it was given. `seats` at launch is
optional/vestigial (v0-style cosmetic pre-naming); identity binding happens
via join links.

## 2. Per-player join links

The Discord match embed carries a **Join** button. Clicking it mints a
`seatToken` bound to the clicker's Discord ID and replies ephemerally with
their personal link: `<joinUrl>&seat=<seatToken>`. The game learns the
token when the player arrives — no second Steward→game sync call, late
joiners work naturally. Tokens are opaque to the game; it binds token →
seat and labels the seat with the display name. Bare-code joins (no token)
still play; those seats report anonymously and earn no stats. Clicking
Join twice returns the same link, not a second seat.

## 3. Results — game → Steward

```
POST <callback.url>
Authorization: Bearer <callback.token>

{
  "code": "ABCD",
  "status": "completed" | "abandoned",
  "seats": [
    { "seatToken": "st_...", "displayName": "Alice", "placement": 1,
      "winner": true, "stats": { "vp": 10, "longestRoad": true } }
  ]
}
```

Sent when the game ends, or best-effort on abandonment/expiry. `seatToken`
is absent for anonymous seats. `stats` is a free-form per-game extras blob:
stored and rendered on the result embed, never aggregated in v1. Webhooks
are idempotent — seats upsert by token, first transition to `completed`
wins and posts embeds.
