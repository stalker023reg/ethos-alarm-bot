import { Markup, type Telegraf } from 'telegraf';
import {
  getFollowAlertPreferences,
  getFollowedUsersWithAlertStatus,
  removeFollow,
  updateFollowAlertPreference,
} from '../db/db';
import type { FollowAlertPreferences } from '../db/models';
import { AuthService, EthosAmbiguousUserError, EthosUserNotFoundError } from '../services/authService';
import { EthosWatchLimitExceededError, FollowService } from '../services/followService';
import { formatProfileSummary } from '../utils/formatters';
import { logger } from '../utils/logger';
import { getCommandArgument } from './helpers';

type FollowAlertScope = 'all' | 'review' | 'vouch';

const WATCH_ALERT_TOGGLE_CALLBACK_PREFIX = 'watch_alerts_toggle_';

const FOLLOW_ALERT_SCOPE_COLUMN: Record<Exclude<FollowAlertScope, 'all'>, 'alerts_reviews_enabled' | 'alerts_vouches_enabled'> = {
  review: 'alerts_reviews_enabled',
  vouch: 'alerts_vouches_enabled',
};

function formatToggleLabel(label: string, enabled: boolean): string {
  return `${enabled ? '🟢' : '🔴'} ${label}`;
}

function buildWatchedProfileKeyboard(
  profileId: string,
  profileUrl: string,
  preferences: FollowAlertPreferences,
) {
  return Markup.inlineKeyboard([
    [
      Markup.button.url('Open on Ethos', profileUrl),
    ],
    [
      Markup.button.callback(
        formatToggleLabel('Alerts', preferences.alerts_enabled),
        `${WATCH_ALERT_TOGGLE_CALLBACK_PREFIX}all_${profileId}`,
      ),
    ],
    [
      Markup.button.callback(
        formatToggleLabel('Reviews', preferences.alerts_reviews_enabled),
        `${WATCH_ALERT_TOGGLE_CALLBACK_PREFIX}review_${profileId}`,
      ),
      Markup.button.callback(
        formatToggleLabel('Vouches', preferences.alerts_vouches_enabled),
        `${WATCH_ALERT_TOGGLE_CALLBACK_PREFIX}vouch_${profileId}`,
      ),
    ],
    [
      Markup.button.callback('❌ Unwatch', `unwatch_${profileId}`),
    ],
  ]);
}

async function applyFollowAlertUpdate(
  tgUserId: number,
  profileId: string,
  scope: FollowAlertScope,
  enabled: boolean,
): Promise<FollowAlertPreferences | null> {
  if (scope === 'all') {
    return updateFollowAlertPreference(tgUserId, profileId, 'alerts_enabled', enabled);
  }

  return updateFollowAlertPreference(tgUserId, profileId, FOLLOW_ALERT_SCOPE_COLUMN[scope], enabled);
}

export function registerWatchCommand(bot: Telegraf, authService: AuthService, followService: FollowService): void {
  bot.command('watch', async (ctx) => {
    const xUsername = getCommandArgument(ctx);

    if (!xUsername) {
      await ctx.reply('Enter X handle to watch Ethos profile (e.g., @username):', Markup.forceReply());
      return;
    }

    try {
      const currentUser = await authService.upsertTelegramUser({ telegramId: String(ctx.from.id) });
      const watchedUser = await followService.watchUser(currentUser.id, xUsername);
      await ctx.reply(`👀 Now watching @${watchedUser.username}`);
    } catch (error) {
      if (error instanceof EthosUserNotFoundError) {
        await ctx.reply('User not found on Ethos');
        return;
      }

      if (error instanceof EthosAmbiguousUserError) {
        await ctx.reply('Multiple users found. Please provide exact username.');
        return;
      }

      if (error instanceof EthosWatchLimitExceededError) {
        await ctx.reply('Maximum 5 profiles allowed');
        return;
      }

      logger.error('Failed to watch Ethos profile', {
        telegramId: ctx.from.id,
        xUsername,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.reply('Unable to watch this profile right now.');
    }
  });

  bot.command('unwatch', async (ctx) => {
    const xUsername = getCommandArgument(ctx);

    if (!xUsername) {
      await ctx.reply('Usage: /unwatch <x_username>');
      return;
    }

    try {
      const currentUser = await authService.upsertTelegramUser({ telegramId: String(ctx.from.id) });
      const watchedUser = await followService.unwatchUser(currentUser.id, xUsername);
      await ctx.reply(`🛑 Stopped watching @${watchedUser.username}`);
    } catch (error) {
      if (error instanceof EthosUserNotFoundError) {
        await ctx.reply('User not found on Ethos');
        return;
      }

      if (error instanceof EthosAmbiguousUserError) {
        await ctx.reply('Multiple users found. Please provide exact username.');
        return;
      }

      logger.error('Failed to unwatch Ethos profile', {
        telegramId: ctx.from.id,
        xUsername,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.reply('Unable to update watch list right now.');
    }
  });

  bot.command('watching', async (ctx) => {
    try {
      const currentUser = await authService.upsertTelegramUser({ telegramId: String(ctx.from.id) });
      const watchedUsers = await getFollowedUsersWithAlertStatus(currentUser.id);

      if (watchedUsers.length === 0) {
        await ctx.reply('👀 Watched profiles\n\nYou are not tracking anyone yet. Use /watch <username>.');
        return;
      }

      await ctx.reply(`👀 You are tracking ${watchedUsers.length}/5 profiles.`);

      for (const watchedProfile of watchedUsers) {
        try {
          const summary = await authService.getProfileSummary(watchedProfile.profileId);
          const messageText = formatProfileSummary(summary);
          const profileUrl = `https://app.ethos.network/profile/x/${summary.username}`;
          const previewMessage = `<a href="${profileUrl}">&#8203;</a>\n${messageText}`;
          const keyboard = buildWatchedProfileKeyboard(watchedProfile.profileId, profileUrl, {
            alerts_enabled: watchedProfile.alertsEnabled,
            alerts_reviews_enabled: watchedProfile.alertsReviewsEnabled,
            alerts_vouches_enabled: watchedProfile.alertsVouchesEnabled,
          });

          await ctx.reply(previewMessage, {
            parse_mode: 'HTML',
            link_preview_options: {
              url: profileUrl,
              show_above_text: true,
              prefer_large_media: true,
            },
            ...keyboard,
          });
        } catch (error) {
          logger.error('Failed to load profile for watched user', {
            profileId: watchedProfile.profileId,
            error: error instanceof Error ? error.message : String(error),
          });
          await ctx.reply(`Unable to load profile data for ID ${watchedProfile.profileId}`);
        }
      }
    } catch (error) {
      logger.error('Failed to load watched Ethos profiles', {
        telegramId: ctx.from.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.reply('Unable to load watched profiles right now.');
    }
  });

  bot.action(new RegExp(`^${WATCH_ALERT_TOGGLE_CALLBACK_PREFIX}(all|review|vouch)_(.+)$`), async (ctx) => {
    const scope = ctx.match[1] as FollowAlertScope;
    const profileId = ctx.match[2];

    try {
      const currentUser = await authService.upsertTelegramUser({ telegramId: String(ctx.from.id) });
      const preferences = await getFollowAlertPreferences(currentUser.id, profileId);

      if (!preferences) {
        await ctx.answerCbQuery('Profile not found in your watch list.');
        return;
      }

      const nextEnabled = scope === 'all'
        ? !preferences.alerts_enabled
        : scope === 'review'
          ? !preferences.alerts_reviews_enabled
          : !preferences.alerts_vouches_enabled;

      const updatedPreferences = await applyFollowAlertUpdate(currentUser.id, profileId, scope, nextEnabled);

      if (!updatedPreferences) {
        await ctx.answerCbQuery('Unable to update alerts.');
        return;
      }

      let profileUrl = `https://app.ethos.network/profile/x/${profileId}`;
      try {
        const summary = await authService.getProfileSummary(profileId);
        profileUrl = `https://app.ethos.network/profile/x/${summary.username}`;
      } catch (error) {
        logger.warn('Failed to resolve watched profile URL for alert toggle', {
          profileId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const newKeyboard = buildWatchedProfileKeyboard(profileId, profileUrl, updatedPreferences);
      const scopeLabel = scope === 'all' ? 'Alerts' : scope === 'review' ? 'Reviews' : 'Vouches';

      await ctx.answerCbQuery(`${scopeLabel} ${nextEnabled ? 'enabled' : 'disabled'}`);

      await ctx.editMessageReplyMarkup(newKeyboard.reply_markup);
    } catch (error) {
      await ctx.answerCbQuery('Unable to update alerts.');
    }
  });

  bot.action(/^unwatch_(.+)$/, async (ctx) => {
    const profileId = ctx.match[1];

    try {
      const currentUser = await authService.upsertTelegramUser({ telegramId: String(ctx.from.id) });
      await removeFollow(currentUser.id, profileId);
      await ctx.answerCbQuery('Profile removed from watch list');
      await ctx.deleteMessage();
    } catch (error) {
      await ctx.answerCbQuery('Unable to remove profile.');
    }
  });
}
