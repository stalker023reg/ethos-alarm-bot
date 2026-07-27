import { Markup, type Context, type Telegraf } from 'telegraf';
import { AuthService, EthosAmbiguousUserError, EthosUserNotFoundError, EthosUserAlreadyLinkedError } from '../services/authService';
import { logger } from '../utils/logger';
import { getCommandArgument } from './helpers';

export async function executeLogin(ctx: Context, authService: AuthService, xUsername: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  try {
    const user = await authService.linkUser(telegramId, xUsername);
    await ctx.reply(
      [
        '✅ Profile linked',
        '',
        `Username: @${user.x_username ?? xUsername.replace(/^@/, '')}`,
        `Profile ID: ${user.profile_id ?? 'n/a'}`,
      ].join('\n'),
    );
  } catch (error) {
    if (error instanceof EthosUserNotFoundError) {
      await ctx.reply('User not found on Ethos');
      return;
    }

    if (error instanceof EthosUserAlreadyLinkedError) {
      await ctx.reply(`❌ You already have a linked profile (@${error.existingUsername}). To link a new one, use /unlink first.`);
      return;
    }

    if (error instanceof EthosAmbiguousUserError) {
      await ctx.reply('Multiple users found. Please provide exact username.');
      return;
    }

    logger.error('Failed to link Ethos profile', {
      telegramId,
      xUsername,
      error: error instanceof Error ? error.message : String(error),
    });
    await ctx.reply('Unable to link profile right now.');
  }
}

export function registerLoginCommand(bot: Telegraf, authService: AuthService): void {
  bot.command('login', async (ctx) => {
    const xUsername = getCommandArgument(ctx);

    if (!xUsername) {
      await ctx.reply('Enter your X handle to link Ethos (e.g., @username):', Markup.forceReply());
      return;
    }

    await executeLogin(ctx, authService, xUsername);
  });
}
