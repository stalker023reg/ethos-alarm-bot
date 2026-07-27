import cron from 'node-cron';
import type { Telegraf } from 'telegraf';
import { config } from '../config/config';
import { NotificationService } from '../services/notificationService';
import { TelegramDeliveryService } from '../services/telegramDeliveryService';
import { logger } from '../utils/logger';
import { processInBatches } from '../utils/rateLimiter';

/**
 * Polls Ethos notifications and forwards new events to Telegram users.
 * Processes users in batches of 5 with delays to avoid API rate limits.
 */
let isRunning = false;
const telegramDeliveryService = new TelegramDeliveryService();

export function startNotificationWorker(bot: Telegraf): void {
  const notificationService = new NotificationService();
  logger.info('Notification worker started');

  const runWorker = async (): Promise<void> => {
    if (isRunning) {
      logger.warn('Notification worker overlaps, skipping this interval');
      return;
    }

    isRunning = true;
    try {
      logger.info('Running notification poll worker');
      let globalSlashDelivered = 0;
      let profileNotificationsDelivered = 0;
      let profileNotificationsPrepared = 0;
      let polledProfiles = 0;
      let skippedProfiles = 0;
      const pollTierCounts = {
        bootstrap: 0,
        hot: 0,
        warm: 0,
        cold: 0,
      };

      const globalSlashBatch = await notificationService.processGlobalSlashNotifications();
      const globalSlashNotifications = globalSlashBatch.deliveries;

      for (const item of globalSlashNotifications) {
        try {
          await telegramDeliveryService.sendMessage(bot.telegram, item.recipientTelegramId, item.message);
          await notificationService.logWatchedNotificationDelivered(item.notification.id, item.recipientUserId);
          globalSlashDelivered += 1;
        } catch (error) {
          logger.error('Failed to deliver global slash notification', {
            telegramId: item.recipientTelegramId,
            notificationId: item.notification.id,
            error: error instanceof Error ? error.message : String(error),
            });
        }
      }

      if (globalSlashBatch.cursorBlock !== null) {
        await notificationService.commitGlobalSlashCursor(globalSlashBatch.cursorBlock);
      }

      let onchainSocialDelivered = 0;
      const socialBatch = await notificationService.processOnchainSocialNotifications();
      const socialNotifications = socialBatch.deliveries;

      const onchainSocialPrepared = socialNotifications.length;

      for (const item of socialNotifications) {
        try {
          await telegramDeliveryService.sendMessage(bot.telegram, item.recipientTelegramId, item.message);
          await notificationService.logWatchedNotificationDelivered(item.notification.id, item.recipientUserId);
          onchainSocialDelivered += 1;
        } catch (error) {
          logger.error('Failed to deliver on-chain social notification', {
            telegramId: item.recipientTelegramId,
            notificationId: item.notification.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (socialBatch.cursorBlock !== null) {
        await notificationService.commitOnchainSocialCursor(socialBatch.cursorBlock);
      }

      const profiles = await notificationService.getTrackedProfiles();
      const eligibleProfiles: string[] = [];

      const fastMode = config.workers.fastNotifications;
      if (fastMode) {
        logger.info('Fast notification polling mode is ACTIVE');
      }

      for (const profileId of profiles) {
        const pollDecision = await notificationService.getProfilePollDecision(profileId);
        pollTierCounts[pollDecision.tier] += 1;

        if (fastMode || pollDecision.shouldPoll) {
          eligibleProfiles.push(profileId);
        } else {
          skippedProfiles += 1;
        }
      }

      await processInBatches(eligibleProfiles, 5, 500, async (profileId) => {
        try {
          const notificationBatch = await notificationService.processProfileNotifications(profileId);
          polledProfiles += 1;
          const notifications = notificationBatch.deliveries;
          profileNotificationsPrepared += notifications.length;

          for (const item of notifications) {
            try {
              await telegramDeliveryService.sendMessage(bot.telegram, item.recipientTelegramId, item.message);

              if (item.updateCursor) {
                await notificationService.markNotificationDelivered(item.notification.id, item.recipientUserId);
              } else {
                await notificationService.logWatchedNotificationDelivered(item.notification.id, item.recipientUserId);
              }
              profileNotificationsDelivered += 1;
            } catch (error) {
              logger.error('Failed to deliver Telegram notification', {
                telegramId: item.recipientTelegramId,
                notificationId: item.notification.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          if (notificationBatch.pollSucceeded) {
            await notificationService.markProfilePolled(profileId);
          }

          if (notificationBatch.cursorTimestamp) {
            await notificationService.commitProfileActivityCursor(profileId, notificationBatch.cursorTimestamp);
          }
        } catch (error) {
          logger.error('Failed to process notifications for profile', {
            profileId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      logger.info('Notification worker summary', {
        trackedProfiles: profiles.length,
        polledProfiles,
        skippedProfiles,
        pollTierCounts,
        globalSlashPrepared: globalSlashNotifications.length,
        globalSlashDelivered,
        onchainSocialPrepared,
        onchainSocialDelivered,
        profileNotificationsPrepared,
        profileNotificationsDelivered,
      });
    } catch (error) {
      logger.error('Notification worker iteration failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      isRunning = false;
    }
  };

  void runWorker();
  cron.schedule(config.workers.notificationPollCron, runWorker);
}
