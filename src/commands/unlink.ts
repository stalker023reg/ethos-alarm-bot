import type { Telegraf } from 'telegraf';
import { AuthService } from '../services/authService';
import { logger } from '../utils/logger';

export function registerUnlinkCommand(bot: Telegraf, authService: AuthService): void {
  bot.command('unlink', async (ctx) => {
    const telegramId = String(ctx.from.id);

    try {
      const user = await authService.getUserByTelegramId(telegramId);

      if (!user?.profile_id) {
        await ctx.reply('No linked Ethos profile found.');
        return;
      }

      await authService.unlinkUser(telegramId);
      await ctx.reply('❌ Profile removed');
    } catch (error) {
      logger.error('Failed to unlink Ethos profile', {
        telegramId,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.reply('Unable to unlink profile right now.');
    }
  });
}
