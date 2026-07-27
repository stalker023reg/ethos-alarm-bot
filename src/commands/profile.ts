import { Markup, type Telegraf } from 'telegraf';
import { AuthService } from '../services/authService';
import { logger } from '../utils/logger';
import { formatProfileSummary } from '../utils/formatters';

async function handleProfileCommand(
  telegramId: string,
  reply: (message: string) => Promise<unknown>,
  replyWithMessage: (profileId: string, username: string, message: string) => Promise<unknown>,
  authService: AuthService,
): Promise<void> {
  try {
    const user = await authService.getUserByTelegramId(telegramId);

    if (!user?.profile_id || !user.x_username) {
      await reply('Link your Ethos profile first with /login <x_username>.');
      return;
    }

    const profile = await authService.getProfileSummary(user.profile_id);
    const messageText = formatProfileSummary(profile);
    await replyWithMessage(profile.profileId, profile.username, messageText);
  } catch (error) {
    logger.error('Failed to load Ethos profile', {
      telegramId,
      error: error instanceof Error ? error.message : String(error),
    });
    await reply('Unable to load your Ethos profile right now.');
  }
}

export function registerProfileCommand(bot: Telegraf, authService: AuthService): void {
  bot.command('profile', async (ctx) => {
    await handleProfileCommand(
      String(ctx.from.id),
      (message) => ctx.reply(message),
      (profileId, username, message) => {
        const profileUrl = `https://app.ethos.network/profile/x/${username}`;
        const previewMessage = `<a href="${profileUrl}">&#8203;</a>\n${message}`;

        return ctx.reply(previewMessage, {
          parse_mode: 'HTML',
          link_preview_options: {
            url: profileUrl,
            show_above_text: true,
            prefer_large_media: true,
          },
          ...Markup.inlineKeyboard([
            [Markup.button.url('Open on Ethos', profileUrl)],
          ]),
        });
      },
      authService
    );
  });

  bot.command('me', async (ctx) => {
    await handleProfileCommand(
      String(ctx.from.id),
      (message) => ctx.reply(message),
      (profileId, username, message) => {
        const profileUrl = `https://app.ethos.network/profile/x/${username}`;
        const previewMessage = `<a href="${profileUrl}">&#8203;</a>\n${message}`;

        return ctx.reply(previewMessage, {
          parse_mode: 'HTML',
          link_preview_options: {
            url: profileUrl,
            show_above_text: true,
            prefer_large_media: true,
          },
          ...Markup.inlineKeyboard([
            [Markup.button.url('Open on Ethos', profileUrl)],
          ]),
        });
      },
      authService
    );
  });
}
