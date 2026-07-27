import path from 'node:path';
import type { Context, Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import { logger } from '../utils/logger';

const MENU_BANNER_PATH = path.join(process.cwd(), 'public', 'menu-banner.png');

export const MENU_TEXT = [
  '🚀 Ethos Alarm Bot',
  '',
  'Ethos Network is a decentralized platform for assessing reputation and trust in the Web3 ecosystem. The project aims to combat fraud in the cryptosphere by creating a transparent on-chain social verification system.',
  '',
  'Commands',
  '🔑 /login <username> — link your Ethos profile',
  '👤 /profile — view your profile',
  '🔥 /xp — view XP and streak',
  '👀 /watch <username> — track a user',
  '📋 /watching — list tracked users',
  '🔔 /alerts — notification settings',
  '📊 /stats — your bot stats',
  '❌ /unlink — unlink profile',
].join('\n');

export async function sendMenu(ctx: Context): Promise<void> {
  try {
    await ctx.replyWithPhoto(Input.fromLocalFile(MENU_BANNER_PATH), {
      caption: MENU_TEXT,
    });
  } catch (error) {
    logger.warn('Failed to send menu banner, falling back to text menu', {
      error: error instanceof Error ? error.message : String(error),
      bannerPath: MENU_BANNER_PATH,
    });
    await ctx.reply(MENU_TEXT);
  }
}

export function registerMenuCommand(bot: Telegraf): void {
  bot.command('menu', async (ctx) => {
    await sendMenu(ctx);
  });
}
