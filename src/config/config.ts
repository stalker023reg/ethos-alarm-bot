import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

/**
 * Centralized application configuration loaded from environment variables.
 */
export const config = {
  app: {
    name: 'ethos-telegram-bot',
    env: process.env.NODE_ENV ?? 'development',
  },
  telegram: {
    token: requireEnv('TELEGRAM_TOKEN'),
    adminId: process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : undefined,
  },
  database: {
    url: requireEnv('DATABASE_URL'),
  },
  auth: {
    publicUrl: process.env.AUTH_PUBLIC_URL?.replace(/\/$/, '') ?? '',
  },
  ethos: {
    baseUrl: process.env.ETHOS_API_BASE
      ? `${process.env.ETHOS_API_BASE.replace(/\/$/, '')}/api/v2`
      : process.env.ETHOS_BASE_URL ?? 'https://api.ethos.network/api/v2',
    clientHeader: 'ethos-telegram-bot',
  },
  base: {
    rpcUrl: process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
  },
  workers: {
    notificationPollCron: process.env.NOTIFICATION_POLL_CRON ?? '*/30 * * * * *',
    fastNotifications: process.env.FAST_NOTIFICATIONS !== 'false',
    rewardCron: process.env.REWARD_CRON ?? '0 3 * * *',
    snapshotPollCron: process.env.SNAPSHOT_POLL_CRON ?? '*/30 * * * *', // Every 30 minutes by default
  },
  snapshot: {
    space: process.env.SNAPSHOT_SPACE ?? 'ethos-labs.eth',
    hubUrl: process.env.SNAPSHOT_HUB_URL ?? 'https://hub.snapshot.org/graphql',
  },
} as const;

/**
 * Throws on startup when required environment variables are missing.
 */
export function validateConfig(): void {
  const required = [
    'TELEGRAM_TOKEN',
    'DATABASE_URL',
  ];

  const missing = required.filter((variable) => !process.env[variable] || process.env[variable]?.trim() === '');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
