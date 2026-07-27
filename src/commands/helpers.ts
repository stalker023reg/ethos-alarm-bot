import type { Context } from 'telegraf';

export function getCommandArgument(ctx: Context): string {
  const message = ctx.message;

  if (!message || !('text' in message)) {
    return '';
  }

  return message.text.split(/\s+/).slice(1).join(' ').trim();
}

export function formatNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'n/a';
  }

  return new Intl.NumberFormat('en-US').format(value);
}

export function formatSignedNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'n/a';
  }

  const formatted = new Intl.NumberFormat('en-US').format(Math.abs(value));
  return `${value >= 0 ? '+' : '-'}${formatted}`;
}

export function formatRank(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'n/a';
  }

  return `#${formatNumber(value)}`;
}

export function formatRelativeTime(date: Date | null): string {
  if (!date) {
    return 'never';
  }

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) {
    return 'just now';
  }

  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
