import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { config } from '../config/config';
import type {
  FollowAlertPreferences,
  FollowRecord,
  LoginSessionRecord,
  UserAlertPreferences,
  UserRecord,
} from './models';
import { createTablesSql } from './models';

/**
 * Shared PostgreSQL connection pool and small query helper.
 */
const isLocalhost = config.database.url.includes('localhost') || config.database.url.includes('127.0.0.1');

export const pool = new Pool({
  connectionString: config.database.url,
  ssl: isLocalhost ? false : { rejectUnauthorized: false },
});

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeDatabase(): Promise<void> {
  await pool.query(createTablesSql);
}

interface UserRow {
  id: string;
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
  last_notification_ts: Date | null;
  last_xp: number;
  last_rank: number | null;
  created_at: Date;
}

interface NotificationExistsRow {
  exists: boolean;
}

interface NotificationLogRow {
  id: string;
  ethos_notification_id: string;
  tg_user_id: string;
  created_at: Date;
}

interface LoggedNotificationRow {
  ethos_notification_id: string;
}

interface LoggedFollowerRow {
  tg_user_id: string;
}

interface FollowRow {
  id: string;
  tg_user_id: string;
  target_profile_id: string;
  target_wallet_address: string | null;
  alerts_enabled: boolean;
  alerts_reviews_enabled: boolean;
  alerts_vouches_enabled: boolean;
}

interface FollowedProfileWatcherRow {
  id: string;
  tg_id: string;
  x_username: string | null;
}

interface FollowAlertRow {
  alerts_enabled: boolean;
  alerts_reviews_enabled: boolean;
  alerts_vouches_enabled: boolean;
}

interface AlertEnabledUserRow {
  id: string;
  tg_id: string;
}

interface SubscriberRow {
  user_id: number;
  tg_id: string;
  is_owner: boolean;
  alerts_reviews_enabled: boolean;
  alerts_vouches_enabled: boolean;
}

interface UserStatsRow {
  tracked_users: string;
  notifications_sent: string;
  last_update: Date | null;
}

interface LoginSessionRow {
  token: string;
  telegram_id: string;
  created_at: Date;
  expires_at: Date;
}

interface WorkerStateRow {
  key: string;
  value: string;
  updated_at: Date;
}

interface TelegramMediaCacheRow {
  cache_key: string;
  file_id: string;
  updated_at: Date;
}

function mapUserRow(row: UserRow): UserRecord {
  return {
    id: Number(row.id),
    tg_id: row.tg_id,
    profile_id: row.profile_id,
    wallet_address: row.wallet_address,
    x_username: row.x_username,
    privy_token: row.privy_token,
    alerts_enabled: row.alerts_enabled,
    alerts_reviews_enabled: row.alerts_reviews_enabled,
    alerts_vouches_enabled: row.alerts_vouches_enabled,
    alerts_slash_enabled: row.alerts_slash_enabled,
    alerts_snapshot_enabled: row.alerts_snapshot_enabled,
    alerts_xp_enabled: row.alerts_xp_enabled,
    last_notification_ts: row.last_notification_ts,
    last_xp: row.last_xp,
    last_rank: row.last_rank,
    created_at: row.created_at,
  };
}

function mapAlertPreferences(row: Pick<
  UserRow,
  'alerts_enabled' | 'alerts_reviews_enabled' | 'alerts_vouches_enabled' | 'alerts_slash_enabled' | 'alerts_snapshot_enabled' | 'alerts_xp_enabled'
>): UserAlertPreferences {
  return {
    alerts_enabled: row.alerts_enabled,
    alerts_reviews_enabled: row.alerts_reviews_enabled,
    alerts_vouches_enabled: row.alerts_vouches_enabled,
    alerts_slash_enabled: row.alerts_slash_enabled,
    alerts_snapshot_enabled: row.alerts_snapshot_enabled,
    alerts_xp_enabled: row.alerts_xp_enabled,
  };
}

function mapFollowAlertPreferences(row: FollowAlertRow): FollowAlertPreferences {
  return {
    alerts_enabled: row.alerts_enabled,
    alerts_reviews_enabled: row.alerts_reviews_enabled,
    alerts_vouches_enabled: row.alerts_vouches_enabled,
  };
}

/**
 * Creates a new Telegram user record linked to an Ethos profile.
 */
export async function createUser(params: {
  tgId: string;
  profileId: string;
  xUsername: string;
}): Promise<UserRecord> {
  const result = await query<UserRow>(
    `
    INSERT INTO users (tg_id, profile_id, x_username)
    VALUES ($1, $2, $3)
    RETURNING id, tg_id, profile_id, wallet_address, x_username, privy_token, alerts_enabled, alerts_reviews_enabled, alerts_vouches_enabled, alerts_slash_enabled, alerts_snapshot_enabled, alerts_xp_enabled, last_notification_ts, last_xp, last_rank, created_at
    `,
    [params.tgId, params.profileId, params.xUsername],
  );

  return mapUserRow(result.rows[0]);
}

/**
 * Updates the linked Ethos profile for an existing Telegram user.
 */
export async function updateUser(params: {
  tgId: string;
  profileId: string;
  xUsername: string;
}): Promise<UserRecord | null> {
  const result = await query<UserRow>(
    `
    UPDATE users
    SET profile_id = $2,
        x_username = $3
    WHERE tg_id = $1
    RETURNING id, tg_id, profile_id, wallet_address, x_username, privy_token, alerts_enabled, alerts_reviews_enabled, alerts_vouches_enabled, alerts_slash_enabled, alerts_snapshot_enabled, alerts_xp_enabled, last_notification_ts, last_xp, last_rank, created_at
    `,
    [params.tgId, params.profileId, params.xUsername],
  );

  return result.rows[0] ? mapUserRow(result.rows[0]) : null;
}

/**
 * Retrieves a user record by Telegram user ID.
 */
export async function getUserByTelegramId(tgId: string): Promise<UserRecord | null> {
  const result = await query<UserRow>(
    `
    SELECT id, tg_id, profile_id, wallet_address, x_username, privy_token, alerts_enabled, alerts_reviews_enabled, alerts_vouches_enabled, alerts_slash_enabled, alerts_snapshot_enabled, alerts_xp_enabled, last_notification_ts, last_xp, last_rank, created_at
    FROM users
    WHERE tg_id = $1
    `,
    [tgId],
  );

  return result.rows[0] ? mapUserRow(result.rows[0]) : null;
}

/**
 * Enables or disables alerts for a Telegram user.
 */
export async function updateAlertsEnabled(tgId: string, enabled: boolean): Promise<UserRecord | null> {
  const result = await query<UserRow>(
    `
    UPDATE users
    SET alerts_enabled = $2
    WHERE tg_id = $1
    RETURNING id, tg_id, profile_id, wallet_address, x_username, privy_token, alerts_enabled, alerts_reviews_enabled, alerts_vouches_enabled, alerts_slash_enabled, alerts_snapshot_enabled, alerts_xp_enabled, last_notification_ts, last_xp, last_rank, created_at
    `,
    [tgId, enabled],
  );

  return result.rows[0] ? mapUserRow(result.rows[0]) : null;
}

export async function getUserAlertPreferences(tgId: string): Promise<UserAlertPreferences | null> {
  const result = await query<UserRow>(
    `
    SELECT alerts_enabled, alerts_reviews_enabled, alerts_vouches_enabled, alerts_slash_enabled, alerts_snapshot_enabled, alerts_xp_enabled
    FROM users
    WHERE tg_id = $1
    `,
    [tgId],
  );

  return result.rows[0] ? mapAlertPreferences(result.rows[0]) : null;
}

export async function updateAlertPreference(
  tgId: string,
  preference: 'alerts_enabled' | 'alerts_reviews_enabled' | 'alerts_vouches_enabled' | 'alerts_slash_enabled' | 'alerts_snapshot_enabled' | 'alerts_xp_enabled',
  enabled: boolean,
): Promise<UserAlertPreferences | null> {
  const result = await query<UserRow>(
    `
    UPDATE users
    SET ${preference} = $2
    WHERE tg_id = $1
    RETURNING alerts_enabled, alerts_reviews_enabled, alerts_vouches_enabled, alerts_slash_enabled, alerts_snapshot_enabled, alerts_xp_enabled
    `,
    [tgId, enabled],
  );

  return result.rows[0] ? mapAlertPreferences(result.rows[0]) : null;
}

/**
 * Removes the linked profile and clears follows for a Telegram user.
 */
export async function unlinkUserByTelegramId(tgId: string): Promise<UserRecord | null> {
  return withTransaction(async (client) => {
    const userResult = await client.query<UserRow>(
      `
      UPDATE users
      SET profile_id = NULL,
          x_username = NULL,
          privy_token = NULL
      WHERE tg_id = $1
      RETURNING id, tg_id, profile_id, wallet_address, x_username, privy_token, alerts_enabled, alerts_reviews_enabled, alerts_vouches_enabled, alerts_slash_enabled, alerts_snapshot_enabled, alerts_xp_enabled, last_notification_ts, last_xp, last_rank, created_at
      `,
      [tgId],
    );

    const row = userResult.rows[0];
    if (!row) {
      return null;
    }

    await client.query(
      `
      DELETE FROM follows
      WHERE tg_user_id = $1
      `,
      [Number(row.id)],
    );

    return mapUserRow(row);
  });
}

/**
 * Creates a follow relationship for a Telegram user and target profile.
 */
export async function addFollow(tgUserId: number, profileId: string): Promise<void> {
  await query(
    `
    INSERT INTO follows (tg_user_id, target_profile_id)
    VALUES ($1, $2)
    ON CONFLICT (tg_user_id, target_profile_id) DO NOTHING
    `,
    [tgUserId, profileId],
  );
}

export async function getFollowedUsers(tgUserId: number): Promise<string[]> {
  const result = await query<{ target_profile_id: string }>(
    `
    SELECT target_profile_id
    FROM follows
    WHERE tg_user_id = $1
    `,
    [tgUserId],
  );
  return result.rows.map(row => row.target_profile_id);
}

export async function getFollowedUsersWithAlertStatus(tgUserId: number): Promise<Array<{
  profileId: string;
  alertsEnabled: boolean;
  alertsReviewsEnabled: boolean;
  alertsVouchesEnabled: boolean;
}>> {
  const result = await query<{
    target_profile_id: string;
    alerts_enabled: boolean;
    alerts_reviews_enabled: boolean;
    alerts_vouches_enabled: boolean;
  }>(
    `
    SELECT target_profile_id, alerts_enabled, alerts_reviews_enabled, alerts_vouches_enabled
    FROM follows
    WHERE tg_user_id = $1
    `,
    [tgUserId],
  );
  return result.rows.map((row) => ({
    profileId: row.target_profile_id,
    alertsEnabled: row.alerts_enabled,
    alertsReviewsEnabled: row.alerts_reviews_enabled,
    alertsVouchesEnabled: row.alerts_vouches_enabled,
  }));
}

export async function toggleFollowAlert(tgUserId: number, profileId: string, enabled: boolean): Promise<void> {
  await query(
    `
    UPDATE follows
    SET alerts_enabled = $3
    WHERE tg_user_id = $1 AND target_profile_id = $2
    `,
    [tgUserId, profileId, enabled],
  );
}

export async function getFollowAlertPreferences(
  tgUserId: number,
  profileId: string,
): Promise<FollowAlertPreferences | null> {
  const result = await query<FollowAlertRow>(
    `
    SELECT alerts_enabled, alerts_reviews_enabled, alerts_vouches_enabled
    FROM follows
    WHERE tg_user_id = $1 AND target_profile_id = $2
    `,
    [tgUserId, profileId],
  );

  return result.rows[0] ? mapFollowAlertPreferences(result.rows[0]) : null;
}

export async function updateFollowAlertPreference(
  tgUserId: number,
  profileId: string,
  preference: 'alerts_enabled' | 'alerts_reviews_enabled' | 'alerts_vouches_enabled',
  enabled: boolean,
): Promise<FollowAlertPreferences | null> {
  const result = await query<FollowAlertRow>(
    `
    UPDATE follows
    SET ${preference} = $3
    WHERE tg_user_id = $1 AND target_profile_id = $2
    RETURNING alerts_enabled, alerts_reviews_enabled, alerts_vouches_enabled
    `,
    [tgUserId, profileId, enabled],
  );

  return result.rows[0] ? mapFollowAlertPreferences(result.rows[0]) : null;
}

/**
 * Removes a follow relationship for a Telegram user and target profile.
 */
export async function removeFollow(tgUserId: number, profileId: string): Promise<void> {
  await query(
    `
    DELETE FROM follows
    WHERE tg_user_id = $1
      AND target_profile_id = $2
    `,
    [tgUserId, profileId],
  );
}

/**
 * Returns followed profile records for a Telegram user.
 */
export async function getFollowsForUser(tgUserId: number): Promise<FollowRecord[]> {
  const result = await query<FollowRow>(
    `
    SELECT id, tg_user_id, target_profile_id, target_wallet_address, alerts_enabled, alerts_reviews_enabled, alerts_vouches_enabled
    FROM follows
    WHERE tg_user_id = $1
    ORDER BY id ASC
    `,
    [tgUserId],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    tg_user_id: Number(row.tg_user_id),
    target_profile_id: row.target_profile_id,
    target_wallet_address: row.target_wallet_address,
    alerts_enabled: row.alerts_enabled,
    alerts_reviews_enabled: row.alerts_reviews_enabled,
    alerts_vouches_enabled: row.alerts_vouches_enabled,
  }));
}

/**
 * Returns a compact stats summary for a Telegram-linked user.
 */
export async function getUserStatsSummary(tgUserId: number): Promise<{
  trackedUsers: number;
  notificationsSent: number;
  lastUpdate: Date | null;
}> {
  const result = await query<UserStatsRow>(
    `
    SELECT
      (SELECT COUNT(*)::text FROM follows WHERE tg_user_id = $1) AS tracked_users,
      (SELECT COUNT(*)::text FROM notifications_log WHERE tg_user_id = $1) AS notifications_sent,
      GREATEST(
        COALESCE((SELECT MAX(created_at) FROM notifications_log WHERE tg_user_id = $1), TO_TIMESTAMP(0)),
        COALESCE((SELECT last_notification_ts FROM users WHERE id = $1), TO_TIMESTAMP(0))
      ) AS last_update
    `,
    [tgUserId],
  );

  const row = result.rows[0];
  const lastUpdate = row?.last_update && row.last_update.getTime() > 0 ? row.last_update : null;

  return {
    trackedUsers: Number(row?.tracked_users ?? 0),
    notificationsSent: Number(row?.notifications_sent ?? 0),
    lastUpdate,
  };
}

/**
 * Returns Telegram users following a given Ethos profile.
 */
export async function getFollowersOfProfile(profileId: string): Promise<Array<{
  id: number;
  tg_id: string;
  x_username: string | null;
}>> {
  const result = await query<FollowedProfileWatcherRow>(
    `
    SELECT u.id, u.tg_id, u.x_username
    FROM follows f
    INNER JOIN users u ON u.id = f.tg_user_id
    WHERE f.target_profile_id = $1
    ORDER BY u.id ASC
    `,
    [profileId],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    tg_id: row.tg_id,
    x_username: row.x_username,
  }));
}

/**
 * Stores a short-lived login token used to link Telegram and Ethos accounts.
 */
export async function createLoginSession(token: string, telegramId: string, expiresAt: Date): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `
      SELECT pg_advisory_xact_lock(hashtext($1))
      `,
      [telegramId],
    );

    await client.query(
      `
      DELETE FROM login_sessions
      WHERE telegram_id = $1
         OR expires_at < NOW()
      `,
      [telegramId],
    );

    await client.query(
      `
      INSERT INTO login_sessions (token, telegram_id, expires_at)
      VALUES ($1, $2, $3)
      `,
      [token, telegramId, expiresAt],
    );
  });
}

/**
 * Consumes a login token once and returns the associated Telegram session data.
 */
export async function consumeLoginSession(token: string): Promise<LoginSessionRecord | null> {
  const result = await query<LoginSessionRow>(
    `
    DELETE FROM login_sessions
    WHERE token = $1
      AND expires_at > NOW()
    RETURNING token, telegram_id, created_at, expires_at
    `,
    [token],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    token: row.token,
    telegram_id: row.telegram_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/**
 * Reads a login session without consuming it to support audit logging.
 */
export async function getLoginSession(token: string): Promise<LoginSessionRecord | null> {
  const result = await query<LoginSessionRow>(
    `
    SELECT token, telegram_id, created_at, expires_at
    FROM login_sessions
    WHERE token = $1
    `,
    [token],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    token: row.token,
    telegram_id: row.telegram_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/**
 * Deletes expired login sessions and returns the number removed.
 */
export async function cleanupExpiredLoginSessions(): Promise<number> {
  const result = await query(
    `
    DELETE FROM login_sessions
    WHERE expires_at < NOW()
    `,
  );

  return result.rowCount ?? 0;
}

/**
 * Checks whether a notification has already been logged for a Telegram user.
 */
export async function notificationExists(notificationId: string, tgUserId?: number): Promise<boolean> {
  const hasUserScope = typeof tgUserId === 'number';
  const result = await query<NotificationExistsRow>(
    `
    SELECT EXISTS(
      SELECT 1
      FROM notifications_log
      WHERE ethos_notification_id = $1
        ${hasUserScope ? 'AND tg_user_id = $2' : ''}
    ) AS exists
    `,
    hasUserScope ? [notificationId, tgUserId] : [notificationId],
  );

  return result.rows[0]?.exists ?? false;
}

/**
 * Loads already processed notification IDs for a user in a single batch query.
 */
export async function getLoggedNotificationsForUser(
  userId: number,
  notificationIds: string[],
): Promise<string[]> {
  if (notificationIds.length === 0) {
    return [];
  }

  const result = await query<LoggedNotificationRow>(
    `
    SELECT ethos_notification_id
    FROM notifications_log
    WHERE tg_user_id = $1
      AND ethos_notification_id = ANY($2)
    `,
    [userId, notificationIds],
  );

  return result.rows.map((row) => row.ethos_notification_id);
}

/**
 * Loads follower user IDs that already received a specific notification.
 */
export async function getFollowersWithLoggedNotification(
  notificationId: string,
  followerIds: number[],
): Promise<number[]> {
  if (followerIds.length === 0) {
    return [];
  }

  const result = await query<LoggedFollowerRow>(
    `
    SELECT tg_user_id
    FROM notifications_log
    WHERE ethos_notification_id = $1
      AND tg_user_id = ANY($2)
    `,
    [notificationId, followerIds],
  );

  return result.rows.map((row) => Number(row.tg_user_id));
}

/**
 * Persists a processed notification to avoid duplicate Telegram delivery.
 */
export async function logNotification(notificationId: string, tgUserId: number): Promise<{
  id: number;
  ethos_notification_id: string;
  tg_user_id: number;
  created_at: Date;
}> {
  const result = await query<NotificationLogRow>(
    `
    INSERT INTO notifications_log (ethos_notification_id, tg_user_id)
    VALUES ($1, $2)
    ON CONFLICT (ethos_notification_id, tg_user_id)
    DO UPDATE SET ethos_notification_id = EXCLUDED.ethos_notification_id
    RETURNING id, ethos_notification_id, tg_user_id, created_at
    `,
    [notificationId, tgUserId],
  );

  const row = result.rows[0];

  return {
    id: Number(row.id),
    ethos_notification_id: row.ethos_notification_id,
    tg_user_id: Number(row.tg_user_id),
    created_at: row.created_at,
  };
}

/**
 * Updates the per-user notification cursor with the newest processed timestamp.
 */
export async function updateUserNotificationCursor(tgUserId: number, timestamp: Date): Promise<void> {
  await query(
    `
    UPDATE users
    SET last_notification_ts = CASE
      WHEN last_notification_ts IS NULL OR last_notification_ts < $2 THEN $2
      ELSE last_notification_ts
    END
    WHERE id = $1
    `,
    [tgUserId, timestamp],
  );
}

/**
 * Reads the current notification cursor for a Telegram-linked user.
 */
export async function getUserNotificationCursor(tgUserId: number): Promise<Date | null> {
  const result = await query<{ last_notification_ts: Date | null }>(
    `
    SELECT last_notification_ts
    FROM users
    WHERE id = $1
    `,
    [tgUserId],
  );

  return result.rows[0]?.last_notification_ts ?? null;
}

export async function getUsersForNightlyXp(): Promise<UserRecord[]> {
  const result = await query<UserRow>(
    `
    SELECT id, tg_id, profile_id, wallet_address, x_username, privy_token, alerts_enabled, alerts_reviews_enabled, alerts_vouches_enabled, alerts_slash_enabled, alerts_snapshot_enabled, alerts_xp_enabled, last_notification_ts, last_xp, last_rank, created_at
    FROM users
    WHERE profile_id IS NOT NULL AND alerts_enabled = TRUE AND alerts_xp_enabled = TRUE
    `
  );

  return result.rows.map(mapUserRow);
}

export async function updateUserNightlyXp(tgId: string, xp: number, rank: number | null): Promise<void> {
  await query(
    `UPDATE users SET last_xp = $2, last_rank = $3 WHERE tg_id = $1`,
    [tgId, xp, rank],
  );
}

/**
 * Returns all distinct profile IDs that need polling for notifications.
 * This includes profiles of registered users with alerts enabled,
 * AND target profiles being watched by users with alerts enabled.
 */
export async function getTrackedProfiles(): Promise<string[]> {
  const result = await query<{ profile_id: string }>(
    `
    SELECT DISTINCT profile_id
    FROM (
      SELECT profile_id
      FROM users
      WHERE profile_id IS NOT NULL
        AND alerts_enabled = TRUE
        AND (alerts_reviews_enabled = TRUE OR alerts_vouches_enabled = TRUE)
      UNION
      SELECT f.target_profile_id AS profile_id
      FROM follows f
      JOIN users u ON f.tg_user_id = u.id
      WHERE u.alerts_enabled = TRUE 
        AND f.alerts_enabled = TRUE
        AND (
          (u.alerts_reviews_enabled = TRUE AND f.alerts_reviews_enabled = TRUE)
          OR (u.alerts_vouches_enabled = TRUE AND f.alerts_vouches_enabled = TRUE)
        )
    ) AS tracked
    `
  );
  return result.rows.map(row => row.profile_id);
}

/**
 * Returns all Telegram users who should be notified about a specific profile's activity.
 */
export async function getSubscribersForProfile(profileId: string): Promise<Array<{
  userId: number;
  tgId: string;
  isOwner: boolean;
  alertsReviewsEnabled: boolean;
  alertsVouchesEnabled: boolean;
}>> {
  const result = await query<SubscriberRow>(
    `
    SELECT
      id AS user_id,
      tg_id,
      true AS is_owner,
      alerts_reviews_enabled,
      alerts_vouches_enabled
    FROM users
    WHERE profile_id = $1
      AND alerts_enabled = TRUE
      AND (alerts_reviews_enabled = TRUE OR alerts_vouches_enabled = TRUE)
    UNION
    SELECT
      u.id AS user_id,
      u.tg_id,
      false AS is_owner,
      (u.alerts_reviews_enabled AND f.alerts_reviews_enabled) AS alerts_reviews_enabled,
      (u.alerts_vouches_enabled AND f.alerts_vouches_enabled) AS alerts_vouches_enabled
    FROM follows f
    JOIN users u ON f.tg_user_id = u.id
    WHERE f.target_profile_id = $1
      AND u.alerts_enabled = TRUE
      AND f.alerts_enabled = TRUE
      AND (
        (u.alerts_reviews_enabled = TRUE AND f.alerts_reviews_enabled = TRUE)
        OR (u.alerts_vouches_enabled = TRUE AND f.alerts_vouches_enabled = TRUE)
      )
    `,
    [profileId]
  );
  return result.rows.map(row => ({
    userId: Number(row.user_id),
    tgId: row.tg_id,
    isOwner: row.is_owner,
    alertsReviewsEnabled: row.alerts_reviews_enabled,
    alertsVouchesEnabled: row.alerts_vouches_enabled,
  }));
}

/**
 * Returns all Telegram users with alerts enabled.
 */
export async function getAlertEnabledUsers(): Promise<Array<{
  userId: number;
  tgId: string;
}>> {
  const result = await query<AlertEnabledUserRow>(
    `
    SELECT id, tg_id
    FROM users
    WHERE alerts_enabled = TRUE
      AND alerts_slash_enabled = TRUE
    `
  );

  return result.rows.map((row) => ({
    userId: Number(row.id),
    tgId: row.tg_id,
  }));
}

/**
 * Returns all Telegram users who should receive Snapshot notifications.
 * Currently returns all users with general alerts enabled.
 */
export async function getSnapshotSubscribers(): Promise<Array<{
  userId: number;
  tgId: string;
}>> {
  const result = await query<AlertEnabledUserRow>(
    `
    SELECT id, tg_id
    FROM users
    WHERE alerts_enabled = TRUE
      AND alerts_snapshot_enabled = TRUE
    `
  );

  return result.rows.map((row) => ({
    userId: Number(row.id),
    tgId: row.tg_id,
  }));
}

/**
 * Reads a worker cursor/state value by key.
 */
export async function getWorkerState(key: string): Promise<string | null> {
  const result = await query<WorkerStateRow>(
    `
    SELECT key, value, updated_at
    FROM worker_state
    WHERE key = $1
    `,
    [key],
  );

  return result.rows[0]?.value ?? null;
}

/**
 * Stores a worker cursor/state value by key.
 */
export async function setWorkerState(key: string, value: string): Promise<void> {
  await query(
    `
    INSERT INTO worker_state (key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key)
    DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()
    `,
    [key, value],
  );
}

/**
 * Reads a cached Telegram file_id by cache key.
 */
export async function getTelegramMediaCache(cacheKey: string): Promise<string | null> {
  const result = await query<TelegramMediaCacheRow>(
    `
    SELECT cache_key, file_id, updated_at
    FROM telegram_media_cache
    WHERE cache_key = $1
    `,
    [cacheKey],
  );

  return result.rows[0]?.file_id ?? null;
}

/**
 * Stores a Telegram file_id for later media reuse.
 */
export async function upsertTelegramMediaCache(cacheKey: string, fileId: string): Promise<void> {
  await query(
    `
    INSERT INTO telegram_media_cache (cache_key, file_id, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (cache_key)
    DO UPDATE SET
      file_id = EXCLUDED.file_id,
      updated_at = NOW()
    `,
    [cacheKey, fileId],
  );
}

/**
 * Updates the wallet address for a user or target profile.
 */
export async function updateProfileAddress(profileId: string, address: string): Promise<void> {
  const normalized = address.toLowerCase();

  await withTransaction(async (client) => {
    await client.query(
      `
      UPDATE users
      SET wallet_address = $2
      WHERE profile_id = $1
      `,
      [profileId, normalized]
    );

    await client.query(
      `
      UPDATE follows
      SET target_wallet_address = $2
      WHERE target_profile_id = $1
      `,
      [profileId, normalized]
    );
  });
}

/**
 * Returns a map of profile IDs to their known wallet addresses.
 */
export async function getProfileAddressMap(): Promise<Map<string, string>> {
  const result = await query<{ profile_id: string; address: string }>(
    `
    SELECT profile_id, wallet_address AS address
    FROM (
      SELECT profile_id, wallet_address
      FROM users
      WHERE profile_id IS NOT NULL AND wallet_address IS NOT NULL
      UNION
      SELECT target_profile_id AS profile_id, target_wallet_address AS wallet_address
      FROM follows
      WHERE target_wallet_address IS NOT NULL
    ) AS mapping
    `
  );

  const map = new Map<string, string>();
  for (const row of result.rows) {
    if (row.profile_id && row.address) {
      map.set(row.profile_id, row.address.toLowerCase());
    }
  }
  return map;
}

/**
 * Returns a list of all profile IDs that are missing a wallet address.
 */
export async function getProfilesMissingAddresses(): Promise<string[]> {
  const result = await query<{ profile_id: string }>(
    `
    SELECT DISTINCT profile_id
    FROM (
      SELECT profile_id
      FROM users
      WHERE profile_id IS NOT NULL AND wallet_address IS NULL
      UNION
      SELECT target_profile_id AS profile_id
      FROM follows
      WHERE target_wallet_address IS NULL
    ) AS missing
    `
  );
  return result.rows.map(row => row.profile_id);
}

/**
 * Returns global bot statistics for administrative overview.
 */
export async function getGlobalBotStats(): Promise<{
  totalUsers: number;
  totalFollows: number;
  totalNotifications: number;
}> {
  const result = await query<{
    users: string;
    follows: string;
    notifications: string;
  }>(
    `
    SELECT
      (SELECT COUNT(*)::text FROM users) AS users,
      (SELECT COUNT(*)::text FROM follows) AS follows,
      (SELECT COUNT(*)::text FROM notifications_log) AS notifications
    `
  );

  const row = result.rows[0];
  return {
    totalUsers: Number(row?.users ?? 0),
    totalFollows: Number(row?.follows ?? 0),
    totalNotifications: Number(row?.notifications ?? 0),
  };
}
