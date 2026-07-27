import type { Telegraf } from 'telegraf';
import { AuthService } from '../services/authService';
import { XpService } from '../services/xpService';
import { logger } from '../utils/logger';
import { formatNumber, formatSignedNumber } from './helpers';
import { formatRewardSummary } from '../utils/formatters';

export function registerXpCommand(bot: Telegraf, authService: AuthService, xpService: XpService): void {
  bot.command('xp', async (ctx) => {
    const telegramId = String(ctx.from.id);
    try {
      const user = await authService.getUserByTelegramId(telegramId);

      if (!user?.profile_id) {
        await ctx.reply('Link your Ethos profile first with /login <x_username>.');
        return;
      }

      const xp = await xpService.getFullXpSummary(user.profile_id);
      const weeklyTotal = xp.currentWeeklyTotals?.total ?? 0;
      const breakdown = formatRewardSummary(xp.rewardsBreakdown);

      const lines = [
        `🔥 XP: ${formatNumber(xp.totalXp)}${xp.rank ? ` (Rank #${formatNumber(xp.rank)})` : ''}`,
        `🔥 Streak: ${formatNumber(xp.xpStreakDays)} days`,
        '',
        `📊 <b>Weekly Rewards: +${weeklyTotal} XP</b>`,
      ];

      if (breakdown && (weeklyTotal > 0 || Object.values(xp.rewardsBreakdown).some(v => v > 0))) {
        lines.push(breakdown);
      } else if (weeklyTotal === 0) {
        lines.push('No rewards accrued this week yet.');
      }

      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    } catch (error) {
      logger.warn('Failed to fetch XP for /xp command', {
        telegramId,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.reply('Unable to fetch XP right now.');
    }
  });
}
