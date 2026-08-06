# Ethos Alarm Bot

Telegram bot for real-time [Ethos Network](https://ethos.network) activity monitoring. Tracks profile events, on-chain slash logs, Snapshot governance proposals, and weekly XP rewards — sends instant notifications straight to Telegram.

**Live bot:** [@EthosAlarmBot](https://t.me/EthosAlarmBot)

---

## What it does

- **Activity notifications** — polls the Ethos API for new reviews, vouches, and other profile events, then forwards them to subscribed users.
- **Slash monitoring** — reads on-chain slash logs from the Base network and alerts all subscribers when a slash event happens.
- **On-chain social tracking** — watches Base smart contract events (vouch, unvouch) and notifies watchers.
- **Snapshot proposals** — monitors the `ethos-labs.eth` Snapshot space for new governance proposals and sends alerts.
- **Weekly XP digest** — every Sunday at 3 AM UTC, sends a breakdown of accrued XP rewards for the week.
- **Watch list** — users can follow any Ethos profile by X handle and get notified about their activity, without linking their own profile.
- **Configurable alerts** — granular per-user and per-follow toggle for reviews, vouches, slashes, Snapshot votes, and XP updates.

## Bot commands

| Command | Description |
|---------|-------------|
| `/login` | Link your Ethos profile via X handle |
| `/profile` | View linked profile info |
| `/xp` | Show current XP and streak |
| `/watch` | Watch any Ethos profile by X handle |
| `/watching` | List all tracked profiles |
| `/alerts` | Configure notification filters |
| `/stats` | View your stats |
| `/unlink` | Unlink profile from bot |

## Tech stack

- **Runtime:** Node.js 20+ with TypeScript
- **Telegram SDK:** [Telegraf](https://github.com/telegraf/telegraf) (long polling)
- **Database:** PostgreSQL (Supabase)
- **Scheduler:** [node-cron](https://github.com/node-cron/node-cron) for worker scheduling
- **On-chain data:** Base mainnet RPC (direct JSON-RPC calls for contract event logs)
- **Governance:** Snapshot Hub GraphQL API
- **HTTP client:** Axios with rate limiting and 429 retry logic
- **Deployment:** Docker multi-stage build → Fly.io (shared-cpu-1x, 256 MB)

## Architecture

```
src/
├── bot.ts                    # Entry point, Telegraf setup, command registration
├── commands/                 # Telegram command handlers
│   ├── alerts.ts             # /alerts — notification filter UI
│   ├── login.ts              # /login — profile linking
│   ├── menu.ts               # /start — welcome menu
│   ├── profile.ts            # /profile — profile display
│   ├── stats.ts              # /stats — user stats
│   ├── unlink.ts             # /unlink — profile unlinking
│   ├── watch.ts              # /watch, /watching — follow management
│   └── xp.ts                 # /xp — XP and streak display
├── config/
│   └── config.ts             # Environment variable loader
├── db/
│   ├── db.ts                 # PostgreSQL queries and connection pool
│   └── models.ts             # TypeScript interfaces and table DDL
├── ethos/
│   ├── ethosClient.ts        # Axios instance with rate limiter
│   ├── notifications.ts      # Ethos activity API wrapper
│   ├── users.ts              # User lookup by X handle
│   ├── xp.ts                 # XP and rewards API
│   ├── baseSlash.ts          # On-chain slash event reader (Base)
│   └── baseSocial.ts         # On-chain social event reader (Base)
├── services/
│   ├── authService.ts        # User creation, profile linking
│   ├── followService.ts      # Watch list management
│   ├── notificationService.ts # Notification preparation and dedup
│   ├── snapshotService.ts    # Snapshot Hub GraphQL client
│   ├── telegramDeliveryService.ts # Telegram message sender with retry
│   ├── telegramMediaService.ts    # Media file caching
│   └── xpService.ts          # XP aggregation and formatting
├── workers/
│   ├── notificationWorker.ts # Cron-based activity + slash + social poller
│   ├── snapshotWorker.ts     # Snapshot proposal poller
│   └── xpWorker.ts           # Weekly XP digest sender
├── utils/
│   ├── cache.ts              # In-memory TTL cache
│   ├── formatters.ts         # Message formatting helpers
│   ├── logger.ts             # Structured JSON logger
│   └── rateLimiter.ts        # Token-bucket rate limiter
├── auth/
│   ├── server.ts             # Express auth endpoint (Privy)
│   └── client.ts             # Browser-side auth flow
└── scripts/
    └── backfill_addresses.ts # One-time wallet address backfill
```

### Workers

The bot runs three background workers in the same process:

1. **Notification worker** — runs every 30 seconds. Fetches new activity from Ethos API, reads on-chain slash and social contract events from Base, deduplicates against the notifications log, and delivers to Telegram. Uses adaptive poll tiers (bootstrap → hot → warm → cold) to reduce API calls for inactive profiles.

2. **Snapshot worker** — runs every 30 minutes. Queries the Snapshot GraphQL Hub for new proposals in the `ethos-labs.eth` space and notifies subscribers.

3. **XP worker** — runs weekly on Sunday at 03:00 UTC. Fetches per-user XP breakdowns and sends a formatted digest with reward categories.

### Reliability safeguards

**Staleness guard** — if the on-chain cursor falls more than `MAX_CATCHUP_BLOCKS` (50,000 blocks ≈ 28 hours) behind the chain head, the bot automatically skips ahead to the latest block instead of processing stale events. This prevents delivering outdated slash/social notifications after prolonged downtime or container restarts.

**Block range** — each polling cycle processes up to `MAX_BLOCK_RANGE` (2,000 blocks) at a time. Base chain produces ~15 blocks per 30 seconds (~1,800 blocks/day), so 2,000 blocks per cycle provides 4× headroom to stay at chain head.

These constants are defined in [`baseSlash.ts`](src/ethos/baseSlash.ts) and [`baseSocial.ts`](src/ethos/baseSocial.ts).

## Setup

### Prerequisites

- Node.js ≥ 20
- PostgreSQL database (Supabase or self-hosted)
- Telegram bot token from [@BotFather](https://t.me/BotFather)

### Environment variables

Copy `.env.example` to `.env` and fill in:

```
TELEGRAM_TOKEN=       # Bot token from BotFather
DATABASE_URL=         # PostgreSQL connection string
AUTH_PUBLIC_URL=       # Public URL for auth page (optional)
```

Optional variables (have defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `ETHOS_API_BASE` | `https://api.ethos.network/api/v2` | Ethos API base URL |
| `BASE_RPC_URL` | `https://mainnet.base.org` | Base chain RPC endpoint |
| `NOTIFICATION_POLL_CRON` | `*/30 * * * * *` | Notification poll interval |
| `FAST_NOTIFICATIONS` | `true` | Poll all profiles every tick |
| `REWARD_CRON` | `0 3 * * *` | XP digest schedule |
| `SNAPSHOT_POLL_CRON` | `*/30 * * * *` | Snapshot poll interval |
| `SNAPSHOT_SPACE` | `ethos-labs.eth` | Snapshot space ID |
| `ADMIN_ID` | — | Telegram admin user ID |

### Install and run

```bash
npm install
npm run build
npm start
```

For development with auto-reload:

```bash
npm run dev
```

### Deploy to Fly.io

```bash
fly deploy
```

The app runs as a single process (`node dist/bot.js`) on a shared-cpu-1x machine with 256 MB RAM. Secrets are set via `fly secrets set`.

## Database

Tables are created automatically on startup (see `src/db/models.ts`):

- `users` — linked Telegram users with alert preferences and XP tracking
- `follows` — per-user watch list with individual alert toggles
- `notifications_log` — deduplication log for delivered notifications
- `login_sessions` — temporary auth tokens
- `worker_state` — persistent key-value state for worker cursors
- `telegram_media_cache` — Telegram file_id cache for re-used media

## Changelog

### 2026-08-06 — Staleness guard & cursor fix

**Problem:** After a Fly.io container restart on July 10, the on-chain slash/social workers stopped advancing cursors for 25 days. When they resumed on August 4, they began processing blocks from March 2025, delivering 138+ outdated slash notifications to users over two days.

**Fix:**
- Reset `base_slash_last_block` and `base_social_last_block` cursors to the current block (~49.6M) in the database
- Added `MAX_CATCHUP_BLOCKS = 50,000` staleness guard to both `baseSlash.ts` and `baseSocial.ts` — if the cursor falls more than ~28 hours behind, the bot skips ahead automatically
- Increased `MAX_BLOCK_RANGE` from 500 to 2,000 blocks per cycle for faster catch-up and 4× safety margin

## License

MIT
