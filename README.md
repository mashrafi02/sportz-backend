# Sportz Backend

A real-time sports score and commentary API. It serves match data over a REST
API and pushes live score and commentary updates to connected clients over
WebSockets. Built with Express 5, TypeScript, Drizzle ORM, and PostgreSQL
(Neon), with Arcjet for bot detection, rate limiting, and shield protection.

## Tech Stack

- **Runtime**: Node.js (ESM) + TypeScript, run via `tsx`
- **Web framework**: Express 5
- **Database**: PostgreSQL (Neon-compatible) via `pg` + Drizzle ORM
- **Validation**: Zod
- **Realtime**: `ws` (raw WebSocket server)
- **Security**: Arcjet (`@arcjet/node`) — shield, bot detection, sliding-window rate limiting

## Project Structure

```
sportz-backend/
├── src/
│   ├── server.ts              # App entry point: Express app, HTTP server, WS attach
│   ├── arcjet.ts               # Arcjet security middleware (HTTP + WebSocket)
│   ├── db/
│   │   ├── db.ts               # Drizzle + pg Pool connection
│   │   └── schema.ts           # Drizzle table definitions (matches, commentary)
│   ├── routes/
│   │   ├── matches.route.ts        # /matches endpoints
│   │   └── commentary.route.ts     # /matches/:id/commentary endpoints
│   ├── validation/
│   │   ├── matches.ts          # Zod schemas + match status helpers
│   │   └── commentary.ts       # Zod schemas for commentary
│   ├── ws/
│   │   └── server.ts           # WebSocket server: subscriptions, broadcasts, rate limiting
│   ├── seed/
│   │   ├── seed.ts             # Seeds matches + replays commentary in real time
│   │   └── data/data.json      # Source dataset for seeding
│   └── data/                   # Seed data
├── drizzle/                     # Generated SQL migrations
├── drizzle.config.ts
└── package.json
```

## Getting Started

### Prerequisites

- Node.js 18+
- A PostgreSQL database (e.g. [Neon](https://neon.tech))
- An [Arcjet](https://arcjet.com) site key

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in `sportz-backend/`:

| Variable | Description | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string | — (required) |
| `PORT` | Port the HTTP/WS server listens on | `8000` |
| `HOST` | Host/interface to bind to | `0.0.0.0` |
| `FRONTEND_ORIGIN` | Allowed CORS origin for the frontend | `http://localhost:3000` |
| `ARCJET_KEY` | Arcjet site key | — (required) |
| `ARCJET_MODE` | `LIVE` or `DRY_RUN` | `LIVE` |
| `ARCJET_ENV` | Set to `development` to relax bot rules locally | — |
| `API_URL` | Base URL the seed script targets when posting matches/commentary | — (required for seeding) |

### 3. Run database migrations

```bash
npm run db:generate   # generate SQL migrations from schema.ts
npm run db:migrate     # apply migrations to DATABASE_URL
```

### 4. Start the dev server

```bash
npm run dev
```

This starts Express + the WebSocket server on `http://${HOST}:${PORT}`
(WebSocket available at the same host on `/ws`), with hot-reload via
`tsx watch`.

### 5. (Optional) Seed demo data

```bash
npm run seed
```

The seed script reads `src/seed/data/data.json`, creates matches via the REST
API (some scheduled, most started as "live"), and then replays each live
match's commentary feed entry-by-entry in real time — updating scores and
broadcasting commentary over the WebSocket as it goes. See
[Demo Data & Scoring Simulation](#demo-data--scoring-simulation) below.

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the API + WS server with hot reload |
| `npm run db:generate` | Generate Drizzle migrations from `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations to the configured database |
| `npm run seed` | Seed matches and replay commentary/score updates in real time |

## Data Model

### `matches`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | serial | Primary key |
| `sport` | text | e.g. `cricket`, `football`, `basketball` |
| `home_team` / `away_team` | text | Team names |
| `status` | enum (`scheduled`, `live`, `finished`) | Defaults to `scheduled` |
| `start_time` / `end_time` | timestamp | `end_time` is nullable |
| `home_score` / `away_score` | text | See [Score Formats](#score-formats) |
| `created_at` | timestamp | Defaults to now |

### `commentary`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | serial | Primary key |
| `match_id` | integer | FK → `matches.id` |
| `minute` / `sequence` | integer | Ordering/timing within the match |
| `period` | text | e.g. `"1st innings"`, `"2nd half"` |
| `event_type` | text | e.g. `goal`, `wicket`, `yellow_card` |
| `actor` / `team` | text | Who/which side the event involves |
| `message` | text | Commentary text (required) |
| `metadata` | jsonb | Free-form extra data |
| `tags` | text[] | Free-form tags |
| `created_at` | timestamp | Defaults to now |

## Match Status Lifecycle

A match's status is one of `scheduled`, `live`, or `finished`. On creation,
`computeMatchStatus(startTime, endTime, now)` derives the initial status from
the provided start/end times:

- `now < startTime` → `scheduled`
- `startTime <= now < endTime` (or no `endTime`) → `live`
- `now >= endTime` → `finished`

Status does not change automatically afterwards — it's updated explicitly via
`PATCH /matches/:id` (e.g. by the seed script once a live match's commentary
feed is exhausted). When a match is `finished`, the frontend determines the
winner by comparing scores and shows a "Winner" badge on the leading team.

## Score Formats

- **Football / Basketball**: plain integer strings, e.g. `"42"`.
- **Cricket**: either `"Yet to bat"` (innings not yet started for that team)
  or `"<runs>/<wickets>"`, e.g. `"187/4"`. Wickets are capped at 10.

## API Endpoints

All responses are JSON. Validation errors return `400` with a Zod
`issues` array.

### `GET /matches`

List matches, most recently created first.

- Query: `limit` (optional, integer 1–100, default 50)
- `200`: `{ "matches": Match[] }`

### `POST /matches`

Create a new match. Status is computed automatically from `startTime`/`endTime`.

- Body:
  ```json
  {
    "sport": "cricket",
    "homeTeam": "India",
    "awayTeam": "Australia",
    "startTime": "2026-06-13T10:00:00Z",
    "endTime": "2026-06-13T18:00:00Z",
    "homeScore": "0",
    "awayScore": "0"
  }
  ```
  `homeScore`/`awayScore` are optional (default `"0"`). `startTime`/`endTime`
  must be ISO datetime strings with an offset, and `endTime` must be after
  `startTime`.
- `201`: `{ "message": "Match created successfully", "match": Match }`
- Broadcasts a `match_created` event to all connected WebSocket clients.

### `PATCH /matches/:id`

Update a match's score and/or status.

- Body (at least one of):
  ```json
  {
    "homeScore": "187/4",
    "awayScore": "Yet to bat",
    "status": "finished"
  }
  ```
- `200`: `{ "message": "Match updated successfully", "match": Match }`
- `404` if the match doesn't exist.
- Broadcasts a `match_updated` event to all connected WebSocket clients.

### `GET /matches/:id/commentary`

List commentary entries for a match, most recent first.

- Query: `limit` (optional, integer 1–100, default applies server-side)
- `200`: `{ "commentary": Commentary[] }`

### `POST /matches/:id/commentary`

Add a commentary entry for a match.

- Body:
  ```json
  {
    "minute": 23,
    "sequence": 5,
    "period": "1st half",
    "eventType": "goal",
    "actor": "Lionel Messi",
    "team": "Argentina",
    "message": "GOAL! A brilliant strike from outside the box.",
    "metadata": { "distance": "22 yards" },
    "tags": ["highlight"]
  }
  ```
  Only `message` is required.
- `201`/`200`: `{ "message": "...", "commentary": Commentary }`
- Broadcasts a `commentary_update` event to WebSocket clients subscribed to
  that match's ID.

## WebSocket Protocol

Connect to `ws://<host>:<port>/ws`. The connection is protected by Arcjet
(shield + bot detection + a 5-requests/2s sliding-window rate limit) — clients
identified as bots or exceeding the limit are rejected during the upgrade.

### Client → Server messages

```json
{ "type": "subscribe", "matchId": 12 }
{ "type": "unsubscribe", "matchId": 12 }
```

Messages are rate-limited to 20 per 10-second window per connection.

### Server → Client messages

| Type | Sent when | Payload |
| --- | --- | --- |
| `welcome` | On connection | Connection acknowledgement |
| `subscribed` | After a `subscribe` message | `{ matchId }` |
| `unsubscribed` | After an `unsubscribe` message | `{ matchId }` |
| `error` | Invalid/rate-limited message | Error details |
| `match_created` | A new match is created | The new match |
| `match_updated` | A match's score/status changes | The updated match |
| `commentary_update` | New commentary for a subscribed match | The commentary entry |

`match_created`/`match_updated` are broadcast to **all** connected clients.
`commentary_update` is sent only to clients subscribed to that specific
`matchId`. The server pings every 30 seconds and terminates connections that
don't respond, to clear out dead sockets.

## Security

`securityMiddleware()` (in `src/arcjet.ts`) runs on every HTTP request and
applies, via Arcjet:

- **Shield** — blocks common attack patterns (SQLi, etc.)
- **Bot detection** — allows search engines/previews (and, in development,
  generic tooling) but blocks other bots
- **Sliding-window rate limiting** — 50 requests / 10s for HTTP

The WebSocket upgrade path applies a separate, stricter Arcjet policy (shield
+ bot detection + 5 requests / 2s).

## Demo Data & Scoring Simulation

`npm run seed` drives a realistic-feeling live demo from
`src/seed/data/data.json`:

- **Cricket**: only one team bats at a time. The non-batting team's score
  shows `"Yet to bat"` until its innings begins (tracked via the commentary's
  `period`, e.g. `"1st innings"` / `"2nd innings"`). Wickets are capped at 10.
- **Football**: goal events from the source data are remapped to a random,
  realistic total (0–5 goals per match) and randomly split between the home
  and away sides, instead of crediting every recorded "goal" event to one
  team.
- **Basketball**: scores update directly from each commentary entry's
  `scoreDelta`. If a match would otherwise end in a tie, a final
  "buzzer-beater" (2 or 3 points for a random side) breaks the deadlock.

Once a live match's commentary feed is exhausted, the seed script issues a
`PATCH /matches/:id` with `status: "finished"`, which the frontend uses to
show the winning team.
