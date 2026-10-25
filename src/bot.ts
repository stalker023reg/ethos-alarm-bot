import { Telegraf } from 'telegraf';
import { registerAlertsCommand } from './commands/alerts';
import { executeLogin, registerLoginCommand } from './commands/login';
import { sendMenu, registerMenuCommand } from './commands/menu';
import { registerProfileCommand } from './commands/profile';
import { registerStatsCommand } from './commands/stats';
import { registerUnlinkCommand } from './commands/unlink';
import { registerWatchCommand } from './commands/watch';
import { registerXpCommand } from './commands/xp';
import { config, validateConfig } from './config/config';
import { initializeDatabase } from './db/db';
import { AuthService } from './services/authService';
import { FollowService } from './services/followService';
import { XpService } from './services/xpService';
import { logger } from './utils/logger';
import { startNotificationWorker } from './workers/notificationWorker';
import { startSnapshotWorker } from './workers/snapshotWorker';
import { startNightlyXpWorker } from './workers/xpWorker';

async function bootstrap(): Promise<void> {
  logger.info('Bootstrap started');
  validateConfig();
  logger.info('Configuration validated');
  await initializeDatabase();
  logger.info('Database initialized');

  const bot = new Telegraf(config.telegram.token);
  const authService = new AuthService();
  const followService = new FollowService();
  const xpService = new XpService();
  logger.info('Core services created');

  await bot.telegram.setMyCommands([
    { command: 'login', description: 'Link Ethos profile (via X handle)' },
    { command: 'profile', description: 'View your profile' },
    { command: 'xp', description: 'View XP and streak' },
    { command: 'watch', description: 'Watch Ethos profile (via X handle)' },
    { command: 'watching', description: 'List tracked users' },
    { command: 'alerts', description: 'Notification filters' },
    { command: 'stats', description: 'Your stats' },
    { command: 'unlink', description: 'Unlink profile' },
  ]);
  logger.info('Telegram commands registered');

  bot.use(async (ctx, next) => {
    if (ctx.updateType === 'message' && ctx.message && 'text' in ctx.message && ctx.message.text?.startsWith('/')) {
      logger.info('command_used', {
        command: ctx.message.text,
        telegramId: ctx.from?.id,
      });
    }

    return next();
  });

  bot.start(async (ctx) => {
    await sendMenu(ctx);
  });

  bot.on('text', async (ctx, next) => {
    if (ctx.message.text.trim().startsWith('/')) {
      return next();
    }

    const replyMessage = ctx.message.reply_to_message;

    if (replyMessage && 'text' in replyMessage) {
      if (replyMessage.text?.includes('Enter your X handle to link Ethos')) {
        const xUsername = ctx.message.text.trim();
        await executeLogin(ctx, authService, xUsername);
        return;
      }

      if (replyMessage.text?.includes('Enter X handle to watch Ethos')) {
        const xUsername = ctx.message.text.trim();

        try {
          const currentUser = await authService.upsertTelegramUser({ telegramId: String(ctx.from.id) });
          const watchedUser = await followService.watchUser(currentUser.id, xUsername);
          await ctx.reply(`👀 Now watching @${watchedUser.username}`);
        } catch (error) {
          await ctx.reply(error instanceof Error ? error.message : 'Failed to add profile.');
        }

        return;
      }

    }

    return next();
  });

  registerMenuCommand(bot);
  registerLoginCommand(bot, authService);
  registerProfileCommand(bot, authService);
  registerXpCommand(bot, authService, xpService);
  registerWatchCommand(bot, authService, followService);
  registerAlertsCommand(bot, authService);
  registerStatsCommand(bot, authService);
  registerUnlinkCommand(bot, authService);
  logger.info('Bot handlers registered');

  bot.catch((error, ctx) => {
    logger.error('Unhandled Telegram bot error', {
      updateType: ctx.updateType,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  logger.info('Checking Telegram bot identity');
  const botIdentity = await bot.telegram.getMe();
  logger.info('Telegram bot identity resolved', {
    id: botIdentity.id,
    username: botIdentity.username,
  });

  logger.info('Starting Telegram long polling');
  void bot.launch().catch((error) => {
    logger.error('Telegram bot polling failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  logger.info('Telegram long polling initiated');
  logger.info('Environment loaded');
  logger.info(`Notification worker cron: ${config.workers.notificationPollCron}`);
  logger.info(`Reward worker cron: ${config.workers.rewardCron}`);

  logger.info('Starting workers');
  startNotificationWorker(bot);
  startNightlyXpWorker(bot);
  startSnapshotWorker(bot);

  logger.info('Telegram bot started');

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    bot.stop(signal);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection detected', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception detected', {
    error: error.message,
    stack: error.stack,
  });
});

void bootstrap().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);

  logger.error('Failed to bootstrap application', {
    error: errorMessage,
    hint: errorMessage.includes('401: Unauthorized')
      ? 'Telegram rejected TELEGRAM_TOKEN. Verify the bot token in .env.'
      : undefined,
  });
  process.exitCode = 1;
});
