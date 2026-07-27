import type { Telegraf } from 'telegraf';
import { AuthService } from '../services/authService';
import { logger } from '../utils/logger';
import { formatNumber, formatRelativeTime } from './helpers';
import { config } from '../config/config';

export function registerStatsCommand(bot: Telegraf, authService: AuthService): void {
  bot.command('stats', async (ctx) => {
    try {
      const user = await authService.upsertTelegramUser({ telegramId: String(ctx.from.id) });
      const stats = await authService.getUserStats(user.id);
      const isAdmin = ctx.from.id === config.telegram.adminId;

      let message = [
        '📊 *Ваша статистика*',
        '',
        `👤 Отслеживаемых: ${formatNumber(stats.trackedUsers)}`,
        `📩 Уведомлений: ${formatNumber(stats.notificationsSent)}`,
        `🕒 Обновлено: ${formatRelativeTime(stats.lastUpdate)}`,
      ].join('\n');

      if (isAdmin) {
        const globalStats = await authService.getGlobalStats();
        message += [
          '\n\n🌐 *Глобальная статистика*',
          '',
          `💎 Всего пользователей: ${formatNumber(globalStats.totalUsers)}`,
          `📣 Всего подписок: ${formatNumber(globalStats.totalFollows)}`,
          `🚀 Всего уведомлений: ${formatNumber(globalStats.totalNotifications)}`,
        ].join('\n');
      }

      message += `\n\n🆔 *Ваш Telegram ID:* \`${ctx.from.id}\``;

      await ctx.replyWithMarkdown(message);
    } catch (error) {
      logger.error('Failed to load stats', {
        telegramId: ctx.from.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.reply('Unable to load stats right now.');
    }
  });
}
