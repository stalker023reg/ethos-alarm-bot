import { Markup, type Context, type Telegraf } from 'telegraf';
import type { UserAlertPreferences } from '../db/models';
import { AuthService } from '../services/authService';
import { logger } from '../utils/logger';
import { getCommandArgument } from './helpers';

type AlertsContext = Context & {
  from: NonNullable<Context['from']>;
  reply: Context['reply'];
};

type GlobalAlertScope = 'all' | 'review' | 'vouch' | 'slash' | 'snapshot' | 'xp';

type AlertCommand =
  | { kind: 'show' }
  | { kind: 'update'; scope: GlobalAlertScope; enabled: boolean };

const GLOBAL_ALERT_TOGGLE_CALLBACK_PREFIX = 'alerts_toggle_';

const GLOBAL_ALERT_SCOPE_COLUMN: Record<Exclude<GlobalAlertScope, 'all'>, 'alerts_reviews_enabled' | 'alerts_vouches_enabled' | 'alerts_slash_enabled' | 'alerts_snapshot_enabled' | 'alerts_xp_enabled'> = {
  review: 'alerts_reviews_enabled',
  vouch: 'alerts_vouches_enabled',
  slash: 'alerts_slash_enabled',
  snapshot: 'alerts_snapshot_enabled',
  xp: 'alerts_xp_enabled',
};

function normalizeGlobalScope(value: string): GlobalAlertScope | null {
  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === 'all' || normalizedValue === 'alerts' || normalizedValue === 'bell') {
    return 'all';
  }

  if (normalizedValue === 'review' || normalizedValue === 'reviews') {
    return 'review';
  }

  if (normalizedValue === 'vouch' || normalizedValue === 'vouches') {
    return 'vouch';
  }

  if (normalizedValue === 'slash' || normalizedValue === 'slashes') {
    return 'slash';
  }

  if (normalizedValue === 'xp' || normalizedValue === 'rank') {
    return 'xp';
  }

  if (normalizedValue === 'snapshot' || normalizedValue === 'proposal' || normalizedValue === 'vote') {
    return 'snapshot';
  }

  return null;
}

function parseEnabled(value: string): boolean | null {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === 'on') {
    return true;
  }

  if (normalizedValue === 'off') {
    return false;
  }

  return null;
}

function parseAlertCommand(input: string): AlertCommand | null {
  const tokens = input
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0 || tokens[0] === 'status') {
    return { kind: 'show' };
  }

  if (tokens.length === 1) {
    const enabled = parseEnabled(tokens[0]);
    if (enabled !== null) {
      return { kind: 'update', scope: 'all', enabled };
    }
    return null;
  }

  if (tokens.length === 2) {
    const scope = normalizeGlobalScope(tokens[0]);
    const enabled = parseEnabled(tokens[1]);

    if (scope && enabled !== null) {
      return { kind: 'update', scope, enabled };
    }
  }

  return null;
}

function formatToggleLabel(label: string, enabled: boolean): string {
  return `${enabled ? '🟢' : '🔴'} ${label}`;
}

function formatGlobalAlertPreferences(preferences: UserAlertPreferences): string {
  return [
    '🔔 Main profile notification settings',
    '',
    'Main',
    `${preferences.alerts_enabled ? '🟢' : '🔴'} Bell`,
    '',
    'Events',
    `${preferences.alerts_reviews_enabled ? '🟢' : '🔴'} Reviews`,
    `${preferences.alerts_vouches_enabled ? '🟢' : '🔴'} Vouches`,
    `${preferences.alerts_slash_enabled ? '🟢' : '🔴'} Slash`,
    '',
    'DAO',
    `${preferences.alerts_snapshot_enabled ? '🟢' : '🔴'} Snapshot`,
    '',
    'System',
    `${preferences.alerts_xp_enabled ? '🟢' : '🔴'} XP Distribution`,
    '',
    'Review, Vouch, and XP apply to your linked profile.',
    'Slash stays in the current global mode.',
  ].join('\n');
}

function buildGlobalAlertsKeyboard(preferences: UserAlertPreferences) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        formatToggleLabel('Bell', preferences.alerts_enabled),
        `${GLOBAL_ALERT_TOGGLE_CALLBACK_PREFIX}all`,
      ),
    ],
    [
      Markup.button.callback(
        formatToggleLabel('Reviews', preferences.alerts_reviews_enabled),
        `${GLOBAL_ALERT_TOGGLE_CALLBACK_PREFIX}review`,
      ),
      Markup.button.callback(
        formatToggleLabel('Vouches', preferences.alerts_vouches_enabled),
        `${GLOBAL_ALERT_TOGGLE_CALLBACK_PREFIX}vouch`,
      ),
    ],
    [
      Markup.button.callback(
        formatToggleLabel('Slash', preferences.alerts_slash_enabled),
        `${GLOBAL_ALERT_TOGGLE_CALLBACK_PREFIX}slash`,
      ),
      Markup.button.callback(
        formatToggleLabel('Snapshot', preferences.alerts_snapshot_enabled),
        `${GLOBAL_ALERT_TOGGLE_CALLBACK_PREFIX}snapshot`,
      ),
    ],
    [
      Markup.button.callback(
        formatToggleLabel('XP Distribution', preferences.alerts_xp_enabled),
        `${GLOBAL_ALERT_TOGGLE_CALLBACK_PREFIX}xp`,
      ),
    ],
  ]);
}

async function loadGlobalAlertPreferences(ctx: AlertsContext, authService: AuthService): Promise<UserAlertPreferences | null> {
  await authService.upsertTelegramUser({ telegramId: String(ctx.from.id) });
  return authService.getAlertPreferences(String(ctx.from.id));
}

async function replyWithGlobalPreferences(ctx: AlertsContext, authService: AuthService): Promise<void> {
  const preferences = await loadGlobalAlertPreferences(ctx, authService);

  if (!preferences) {
    await ctx.reply('Unable to load alert settings right now.');
    return;
  }

  await ctx.reply(formatGlobalAlertPreferences(preferences), buildGlobalAlertsKeyboard(preferences));
}

async function applyGlobalAlertUpdate(
  authService: AuthService,
  telegramId: string,
  scope: GlobalAlertScope,
  enabled: boolean,
): Promise<UserAlertPreferences | null> {
  await authService.upsertTelegramUser({ telegramId });

  if (scope === 'all') {
    await authService.setAlertsEnabled(telegramId, enabled);
    return authService.getAlertPreferences(telegramId);
  }

  return authService.setAlertPreference(telegramId, GLOBAL_ALERT_SCOPE_COLUMN[scope], enabled);
}

export async function executeAlerts(
  ctx: AlertsContext,
  authService: AuthService,
  value: string,
): Promise<void> {
  const parsedCommand = parseAlertCommand(value);

  if (!parsedCommand) {
    await ctx.reply('Invalid alert command.');
    return;
  }

  try {
    if (parsedCommand.kind === 'show') {
      await replyWithGlobalPreferences(ctx, authService);
      return;
    }

    const preferences = await applyGlobalAlertUpdate(
      authService,
      String(ctx.from.id),
      parsedCommand.scope,
      parsedCommand.enabled,
    );

    if (!preferences) {
      await ctx.reply('Unable to update alerts right now.');
      return;
    }

    await ctx.reply(formatGlobalAlertPreferences(preferences), buildGlobalAlertsKeyboard(preferences));
  } catch (error) {
    logger.error('Failed to update alerts preference', {
      telegramId: ctx.from.id,
      value,
      error: error instanceof Error ? error.message : String(error),
    });
    await ctx.reply('Unable to update alerts right now.');
  }
}

export function registerAlertsCommand(bot: Telegraf, authService: AuthService): void {
  bot.command('alerts', async (ctx) => {
    const value = getCommandArgument(ctx);

    if (!value) {
      await replyWithGlobalPreferences(ctx as AlertsContext, authService);
      return;
    }

    await executeAlerts(ctx as AlertsContext, authService, value);
  });

  bot.action(new RegExp(`^${GLOBAL_ALERT_TOGGLE_CALLBACK_PREFIX}(.+)$`), async (ctx) => {
    try {
      const rawScope = ctx.match[1];
      const scope = normalizeGlobalScope(rawScope);

      if (!scope) {
        await ctx.answerCbQuery('Unknown alert filter.');
        return;
      }

      const preferences = await loadGlobalAlertPreferences(ctx as AlertsContext, authService);
      if (!preferences) {
        await ctx.answerCbQuery('Unable to load settings.');
        return;
      }

      const nextEnabled = scope === 'all'
        ? !preferences.alerts_enabled
        : scope === 'review'
          ? !preferences.alerts_reviews_enabled
          : scope === 'vouch'
            ? !preferences.alerts_vouches_enabled
            : scope === 'slash'
              ? !preferences.alerts_slash_enabled
              : scope === 'snapshot'
                ? !preferences.alerts_snapshot_enabled
                : !preferences.alerts_xp_enabled;

      const updatedPreferences = await applyGlobalAlertUpdate(
        authService,
        String(ctx.from.id),
        scope,
        nextEnabled,
      );

      if (!updatedPreferences) {
        await ctx.answerCbQuery('Unable to update settings.');
        return;
      }

      await ctx.answerCbQuery(`${scope === 'all' ? 'Bell' : scope} ${nextEnabled ? 'enabled' : 'disabled'}`);
      await ctx.editMessageText(formatGlobalAlertPreferences(updatedPreferences), {
        ...buildGlobalAlertsKeyboard(updatedPreferences),
      });
    } catch (error) {
      logger.error('Failed to handle global alerts toggle callback', {
        telegramId: ctx.from?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.answerCbQuery('Unable to update settings.');
    }
  });
}
