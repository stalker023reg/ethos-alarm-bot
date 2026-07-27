import {
  getAlertEnabledUsers,
  getTrackedProfiles,
  getSubscribersForProfile,
  getFollowersWithLoggedNotification,
  getWorkerState,
  setWorkerState,
  logNotification,
  notificationExists,
  getProfileAddressMap,
} from '../db/db';
import type { NotificationLogRecord, UserRecord } from '../db/models';
import { BASE_SLASH_WORKER_STATE_KEY, getOnchainSlashBatch } from '../ethos/baseSlash';
import { BASE_SOCIAL_WORKER_STATE_KEY, getOnchainSocialBatch } from '../ethos/baseSocial';
import { getPublicActivity, getSocialActivityByTxHash, type EthosNotification } from '../ethos/notifications';
import { formatGlobalSlashNotification, formatNotificationMessage, formatWatchedNotification } from '../utils/formatters';
import { logger } from '../utils/logger';

interface UserRow {
  id: string;
  tg_id: string;
  profile_id: string | null;
  x_username: string | null;
  privy_token: string | null;
  alerts_enabled: boolean;
  last_notification_ts: Date | null;
  last_xp: number;
  last_rank: number | null;
  created_at: Date;
}

const SUPPORTED_NOTIFICATION_TYPES = new Set([
  'REVIEW',
  'VOUCH',
]);

const GLOBAL_SLASH_TYPES = new Set([
  'SLASH_CREATE',
  'SLASH_COMPLETE',
]);

export interface DeliverableNotification {
  notification: EthosNotification;
  message: string;
  recipientTelegramId: string;
  recipientUserId: number;
  updateCursor: boolean;
}

export interface GlobalSlashBatchResult {
  deliveries: DeliverableNotification[];
  cursorBlock: number | null;
}

export interface ProfileNotificationBatchResult {
  deliveries: DeliverableNotification[];
  cursorTimestamp: string | null;
  pollSucceeded: boolean;
}

export interface ProfilePollDecision {
  shouldPoll: boolean;
  intervalMs: number;
  tier: 'bootstrap' | 'hot' | 'warm' | 'cold';
  lastProcessedTimestamp: string | null;
  lastPolledAt: string | null;
}

const PROFILE_POLL_INTERVALS_MS = {
  bootstrap: 30_000,
  hot: 30_000,
  warm: 2 * 60_000,
  cold: 5 * 60_000,
} as const;

const PROFILE_ACTIVITY_HOT_WINDOW_MS = 6 * 60 * 60 * 1000;
const PROFILE_ACTIVITY_WARM_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Coordinates fetching, deduplicating, and preparing notification delivery.
 */
export class NotificationService {
  async getTrackedProfiles(): Promise<string[]> {
    return getTrackedProfiles();
  }

  async processGlobalSlashNotifications(): Promise<GlobalSlashBatchResult> {
    try {
      const slashBatch = await getOnchainSlashBatch();
      const notifications = slashBatch.notifications;
      const subscribers = await getAlertEnabledUsers();

      if (subscribers.length === 0 || notifications.length === 0) {
        logger.info('No global slash notifications to process', {
          fetchedCount: notifications.length,
          subscriberCount: subscribers.length,
          fromBlock: slashBatch.fromBlock,
          toBlock: slashBatch.toBlock,
        });
        return {
          deliveries: [],
          cursorBlock: slashBatch.toBlock,
        };
      }

      const supportedNotifications = notifications.filter((notification) => this.isGlobalSlashNotification(notification));
      const subscriberIds = subscribers.map((subscriber) => subscriber.userId);
      const deliveries: DeliverableNotification[] = [];

      logger.info('Processing global slash notifications', {
        fetchedCount: notifications.length,
        supportedCount: supportedNotifications.length,
        subscriberCount: subscribers.length,
        fromBlock: slashBatch.fromBlock,
        toBlock: slashBatch.toBlock,
      });

      for (const notification of supportedNotifications) {
        const loggedUserIds = await getFollowersWithLoggedNotification(notification.id, subscriberIds);
        const loggedSet = new Set(loggedUserIds);

        for (const subscriber of subscribers) {
          if (loggedSet.has(subscriber.userId)) {
            continue;
          }

          loggedSet.add(subscriber.userId);
          deliveries.push({
            notification,
            message: formatGlobalSlashNotification(notification),
            recipientTelegramId: subscriber.tgId,
            recipientUserId: subscriber.userId,
            updateCursor: false,
          });
        }
      }

      logger.info('Prepared global slash deliveries', {
        deliveries: deliveries.length,
      });

      return {
        deliveries,
        cursorBlock: slashBatch.toBlock,
      };
    } catch (error) {
      logger.error('Failed to process global slash notifications', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        deliveries: [],
        cursorBlock: null,
      };
    }
  }

  async commitGlobalSlashCursor(blockNumber: number): Promise<void> {
    await setWorkerState(BASE_SLASH_WORKER_STATE_KEY, String(blockNumber));
  }

  async processOnchainSocialNotifications(): Promise<GlobalSlashBatchResult> {
    try {
      const socialBatch = await getOnchainSocialBatch();
      const events = socialBatch.events;
      const addressMap = await getProfileAddressMap();

      if (events.length === 0) {
        return { deliveries: [], cursorBlock: socialBatch.toBlock };
      }

      const deliveries: DeliverableNotification[] = [];

      for (const event of events) {
        const profileId = [...addressMap.entries()].find(([_, addr]) => addr === event.targetAddress)?.[0];
        
        if (!profileId) {
          continue;
        }

        // Fetch subscribers for this profile
        const subscribers = await getSubscribersForProfile(profileId);
        if (subscribers.length === 0) continue;

        // Try to enrich via API
        const notification = await getSocialActivityByTxHash(event.txHash);
        if (!notification) {
          logger.warn('Could not enrich on-chain social event', { txHash: event.txHash });
          continue;
        }

        const subscriberIds = subscribers.map(s => s.userId);
        const loggedUserIds = await getFollowersWithLoggedNotification(notification.id, subscriberIds);
        const loggedSet = new Set(loggedUserIds);

        for (const sub of subscribers) {
          if (!this.subscriberAllowsNotification(sub, notification)) continue;
          if (loggedSet.has(sub.userId)) continue;

          loggedSet.add(sub.userId);
          deliveries.push({
            notification,
            message: sub.isOwner ? formatNotificationMessage(notification) : formatWatchedNotification(notification),
            recipientTelegramId: sub.tgId,
            recipientUserId: sub.userId,
            updateCursor: false,
          });
        }
      }

      return { deliveries, cursorBlock: socialBatch.toBlock };
    } catch (error) {
      logger.error('Failed to process on-chain social notifications', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { deliveries: [], cursorBlock: null };
    }
  }

  async commitOnchainSocialCursor(blockNumber: number): Promise<void> {
    await setWorkerState(BASE_SOCIAL_WORKER_STATE_KEY, String(blockNumber));
  }

  async markNotificationDelivered(notificationId: string, userId: number): Promise<NotificationLogRecord> {
    const row = await logNotification(notificationId, userId);
    return {
      id: row.id,
      ethos_notification_id: row.ethos_notification_id,
      tg_user_id: row.tg_user_id,
      created_at: row.created_at,
    };
  }

  async logWatchedNotificationDelivered(notificationId: string, userId: number): Promise<NotificationLogRecord> {
    const row = await logNotification(notificationId, userId);
    return {
      id: row.id,
      ethos_notification_id: row.ethos_notification_id,
      tg_user_id: row.tg_user_id,
      created_at: row.created_at,
    };
  }

  async isNotificationLogged(notificationId: string, userId: number): Promise<boolean> {
    return notificationExists(notificationId, userId);
  }

  async getProfilePollDecision(profileId: string, now: Date = new Date()): Promise<ProfilePollDecision> {
    const lastProcessedTimestamp = await getWorkerState(this.getProfileActivityCursorKey(profileId));
    const lastPolledAt = await getWorkerState(this.getProfilePollStateKey(profileId));
    const tier = this.getProfilePollTier(lastProcessedTimestamp, now);
    const intervalMs = PROFILE_POLL_INTERVALS_MS[tier];
    const lastPollDate = this.parseNotificationTimestamp(lastPolledAt ?? undefined);

    if (!lastPollDate) {
      return {
        shouldPoll: true,
        intervalMs,
        tier,
        lastProcessedTimestamp,
        lastPolledAt,
      };
    }

    return {
      shouldPoll: now.getTime() - lastPollDate.getTime() >= intervalMs,
      intervalMs,
      tier,
      lastProcessedTimestamp,
      lastPolledAt,
    };
  }

  async markProfilePolled(profileId: string, now: Date = new Date()): Promise<void> {
    await setWorkerState(this.getProfilePollStateKey(profileId), now.toISOString());
  }

  async processProfileNotifications(profileId: string): Promise<ProfileNotificationBatchResult> {
    try {
      const fetchedNotifications = await getPublicActivity(profileId);
      const subscribers = await getSubscribersForProfile(profileId);
      const cursorKey = this.getProfileActivityCursorKey(profileId);
      const lastProcessedTimestamp = await getWorkerState(cursorKey);
      const latestTimestamp = this.getLatestNotificationTimestamp(fetchedNotifications);

      if (subscribers.length === 0 || fetchedNotifications.length === 0) {
        logger.info('No notifications to process for profile', {
          profileId,
          fetchedCount: fetchedNotifications.length,
          subscriberCount: subscribers.length,
          lastProcessedTimestamp,
        });
        return {
          deliveries: [],
          cursorTimestamp: latestTimestamp,
          pollSucceeded: true,
        };
      }

      if (!lastProcessedTimestamp) {
        logger.info('Initializing profile notification cursor without backfill', {
          profileId,
          fetchedCount: fetchedNotifications.length,
          subscriberCount: subscribers.length,
          cursorTimestamp: latestTimestamp,
        });
        return {
          deliveries: [],
          cursorTimestamp: latestTimestamp,
          pollSucceeded: true,
        };
      }

      const deliveries: DeliverableNotification[] = [];
      const notifications = fetchedNotifications.slice(0, 100);

      const sortedNotifications = [...notifications].sort((left, right) => {
        const leftTimestamp = this.parseNotificationTimestamp(left.createdAt)?.getTime() ?? 0;
        const rightTimestamp = this.parseNotificationTimestamp(right.createdAt)?.getTime() ?? 0;
        return leftTimestamp - rightTimestamp;
      });

      const supportedNotifications = sortedNotifications.filter((notification) => {
        if (!this.isSupportedNotification(notification)) {
          return false;
        }

        if (!lastProcessedTimestamp) {
          return true;
        }

        const createdAt = this.parseNotificationTimestamp(notification.createdAt);
        const cursorTimestamp = this.parseNotificationTimestamp(lastProcessedTimestamp);

        if (!createdAt || !cursorTimestamp) {
          return true;
        }

        return createdAt.getTime() > cursorTimestamp.getTime();
      });
      const subscriberIds = subscribers.map(s => s.userId);
      logger.info('Processing profile notifications', {
        profileId,
        fetchedCount: fetchedNotifications.length,
        supportedCount: supportedNotifications.length,
        subscriberCount: subscribers.length,
        lastProcessedTimestamp,
      });

      for (const notification of supportedNotifications) {
        const loggedUserIds = await getFollowersWithLoggedNotification(notification.id, subscriberIds);
        const loggedSet = new Set(loggedUserIds);

        for (const sub of subscribers) {
          if (!this.subscriberAllowsNotification(sub, notification)) {
            continue;
          }

          if (loggedSet.has(sub.userId)) {
            continue;
          }

          // Deduplicate in-memory to prevent multiple sends on same loop
          loggedSet.add(sub.userId);

          deliveries.push({
            notification,
            message: sub.isOwner ? formatNotificationMessage(notification) : formatWatchedNotification(notification),
            recipientTelegramId: sub.tgId,
            recipientUserId: sub.userId,
            updateCursor: sub.isOwner,
          });
        }
      }

      logger.info('Prepared notification deliveries', {
        profileId,
        deliveries: deliveries.length,
      });
      return {
        deliveries,
        cursorTimestamp: this.getLatestNotificationTimestamp(sortedNotifications),
        pollSucceeded: true,
      };
    } catch (error) {
      logger.error('Failed to fetch notifications for profile', {
        profileId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        deliveries: [],
        cursorTimestamp: null,
        pollSucceeded: false,
      };
    }
  }

  async commitProfileActivityCursor(profileId: string, timestamp: string): Promise<void> {
    await setWorkerState(this.getProfileActivityCursorKey(profileId), timestamp);
  }

  private isSupportedNotification(notification: EthosNotification): boolean {
    return typeof notification.type === 'string' && SUPPORTED_NOTIFICATION_TYPES.has(notification.type);
  }

  private isGlobalSlashNotification(notification: EthosNotification): boolean {
    return typeof notification.type === 'string' && GLOBAL_SLASH_TYPES.has(notification.type);
  }

  private subscriberAllowsNotification(
    subscriber: {
      alertsReviewsEnabled: boolean;
      alertsVouchesEnabled: boolean;
    },
    notification: EthosNotification,
  ): boolean {
    if (notification.type === 'REVIEW') {
      return subscriber.alertsReviewsEnabled;
    }

    if (notification.type === 'VOUCH') {
      return subscriber.alertsVouchesEnabled;
    }

    return false;
  }

  private parseNotificationTimestamp(createdAt?: string): Date | null {
    if (!createdAt) {
      return null;
    }

    const timestamp = new Date(createdAt);
    return Number.isNaN(timestamp.getTime()) ? null : timestamp;
  }

  private getLatestNotificationTimestamp(notifications: EthosNotification[]): string | null {
    const timestamps = notifications
      .map((notification) => this.parseNotificationTimestamp(notification.createdAt))
      .filter((timestamp): timestamp is Date => timestamp !== null)
      .sort((left, right) => right.getTime() - left.getTime());

    return timestamps[0]?.toISOString() ?? null;
  }

  private getProfileActivityCursorKey(profileId: string): string {
    return `profile_activity_last_ts:${profileId}`;
  }

  private getProfilePollStateKey(profileId: string): string {
    return `profile_activity_last_poll_ts:${profileId}`;
  }

  private getProfilePollTier(
    lastProcessedTimestamp: string | null,
    now: Date,
  ): 'bootstrap' | 'hot' | 'warm' | 'cold' {
    const cursorDate = this.parseNotificationTimestamp(lastProcessedTimestamp ?? undefined);

    if (!cursorDate) {
      return 'bootstrap';
    }

    const ageMs = now.getTime() - cursorDate.getTime();

    if (ageMs <= PROFILE_ACTIVITY_HOT_WINDOW_MS) {
      return 'hot';
    }

    if (ageMs <= PROFILE_ACTIVITY_WARM_WINDOW_MS) {
      return 'warm';
    }

    return 'cold';
  }

  private getNotificationCacheKey(userId: number, notificationId: string): string {
    return `${userId}:${notificationId}`;
  }

  private getTargetProfileId(notification: EthosNotification): string | null {
    const metadata = notification.metadata;

    if (!metadata || typeof metadata !== 'object') {
      return null;
    }

    const paths = [
      ['target', 'profileId'],
      ['profile', 'profileId'],
      ['subject', 'profileId'],
      ['toUser', 'profileId'],
      ['targetProfileId'],
      ['profileId'],
    ];

    for (const path of paths) {
      let current: unknown = metadata;

      for (const segment of path) {
        if (!current || typeof current !== 'object' || !(segment in current)) {
          current = null;
          break;
        }

        current = (current as Record<string, unknown>)[segment];
      }

      if (typeof current === 'string' && current.trim()) {
        return current.trim();
      }
    }

    return null;
  }
}
