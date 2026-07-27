import cron from 'node-cron';
import type { Telegraf } from 'telegraf';
import { getUsersForNightlyXp, updateUserNightlyXp } from '../db/db';
import { TelegramDeliveryService } from '../services/telegramDeliveryService';
import { XpService } from '../services/xpService';
import { logger } from '../utils/logger';
import { sleep } from '../utils/rateLimiter';
import { formatRewardSummary } from '../utils/formatters';

const xpService = new XpService();
const telegramDeliveryService = new TelegramDeliveryService();

export function startNightlyXpWorker(bot: Telegraf): void {
  logger.info('Nightly XP worker started', {
    cron: '0 3 * * 0',
  });

  cron.schedule('0 3 * * 0', async () => {
    logger.info('Running nightly XP worker');

    try {
      const users = await getUsersForNightlyXp();

      for (const user of users) {
        if (!user.profile_id) {
          continue;
        }

        try {
          const xp = await xpService.getFullXpSummary(user.profile_id);
          const currentXp = xp.totalXp;
          const currentRank = xp.rank;
          
          const weeklyTotal = xp.currentWeeklyTotals?.total ?? 0;
          const hasBreakdown = Object.values(xp.rewardsBreakdown).some(v => v > 0);

          if (weeklyTotal > 0 || hasBreakdown) {
            const breakdownText = formatRewardSummary(xp.rewardsBreakdown);
            const message = [
              '📊 <b>Ethos Weekly Rewards Update</b>',
              '',
              `Total accrued this week: <b>+${weeklyTotal} XP</b>`,
              '',
              breakdownText,
              '',
              '<i>Note: Categories show cumulative weekly totals.</i>'
            ].filter(Boolean).join('\n');

            await telegramDeliveryService.sendMessage(bot.telegram, user.tg_id, message, { parse_mode: 'HTML' });
          } else if (currentXp > user.last_xp && user.last_xp === 0) {
            // Initializing tracking
            const message = [
              '📊 <b>Ethos Weekly Rewards</b>',
              '',
              'Your XP tracking has been initialized!',
              'You will receive rewards updates here.',
            ].join('\n');

            await telegramDeliveryService.sendMessage(bot.telegram, user.tg_id, message, { parse_mode: 'HTML' });
          }

          if (currentXp !== user.last_xp || currentRank !== user.last_rank) {
            await updateUserNightlyXp(user.tg_id, currentXp, currentRank);
          }
        } catch (error) {
          logger.error('Failed to process nightly XP for user', {
            telegramId: user.tg_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        await sleep(200);
      }
    } catch (error) {
      logger.error('Nightly XP worker failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
