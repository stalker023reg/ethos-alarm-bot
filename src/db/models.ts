/**
 * Typed database models and initialization SQL for PostgreSQL tables.
 */
export interface UserRecord {
  id: number;
  tg_id: string;
  profile_id: string | null;
  wallet_address: string | null;
  x_username: string | null;
  privy_token: string | null;
  alerts_enabled: boolean;
  alerts_reviews_enabled: boolean;
  alerts_vouches_enabled: boolean;
  alerts_slash_enabled: boolean;
  alerts_snapshot_enabled: boolean;
  alerts_xp_enabled: boolean;
  last_notification_ts?: Date | null;
  last_xp: number;
  last_rank: number | null;
  created_at: Date;
}

export interface UserAlertPreferences {
  alerts_enabled: boolean;
  alerts_reviews_enabled: boolean;
  alerts_vouches_enabled: boolean;
  alerts_slash_enabled: boolean;
  alerts_snapshot_enabled: boolean;
  alerts_xp_enabled: boolean;
}

export interface FollowRecord {
  id: number;
  tg_user_id: number;
  target_profile_id: string;
  target_wallet_address: string | null;
  alerts_enabled?: boolean;
  alerts_reviews_enabled?: boolean;
  alerts_vouches_enabled?: boolean;
}

export interface FollowAlertPreferences {
  alerts_enabled: boolean;
  alerts_reviews_enabled: boolean;
  alerts_vouches_enabled: boolean;
}

export interface NotificationLogRecord {
  id: number;
  ethos_notification_id: string;
  tg_user_id: number;
  created_at: Date;
}

export interface LoginSessionRecord {
  token: string;
  telegram_id: string;
  created_at: Date;
  expires_at: Date;
}

export interface WorkerStateRecord {
  key: string;
  value: string;
  updated_at: Date;
}

export interface TelegramMediaCacheRecord {
  cache_key: string;
  file_id: string;
  updated_at: Date;
}

export const createTablesSql = `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  tg_id TEXT NOT NULL UNIQUE,
  profile_id TEXT,
  wallet_address TEXT,
  x_username TEXT,
  privy_token TEXT,
  alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  alerts_reviews_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  alerts_vouches_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  alerts_slash_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_notification_ts TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_notification_ts TIMESTAMPTZ NULL;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_xp INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_rank INTEGER;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS alerts_reviews_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS alerts_vouches_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS alerts_slash_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS alerts_snapshot_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS wallet_address TEXT;

CREATE TABLE IF NOT EXISTS follows (
  id BIGSERIAL PRIMARY KEY,
  tg_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_profile_id TEXT NOT NULL,
  target_wallet_address TEXT,
  alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  alerts_reviews_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  alerts_vouches_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tg_user_id, target_profile_id)
);

ALTER TABLE follows
ADD COLUMN IF NOT EXISTS target_wallet_address TEXT;

ALTER TABLE follows
ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE follows
ADD COLUMN IF NOT EXISTS alerts_reviews_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE follows
ADD COLUMN IF NOT EXISTS alerts_vouches_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS notifications_log (
  id BIGSERIAL PRIMARY KEY,
  ethos_notification_id TEXT NOT NULL,
  tg_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ethos_notification_id, tg_user_id)
);

CREATE TABLE IF NOT EXISTS login_sessions (
  token TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE login_sessions
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS login_sessions_telegram_idx
ON login_sessions(telegram_id);

CREATE TABLE IF NOT EXISTS worker_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_media_cache (
  cache_key TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
