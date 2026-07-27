import type { Telegram } from 'telegraf';
import { logger } from '../utils/logger';
import { sleep } from '../utils/rateLimiter';

const DEFAULT_MESSAGE_INTERVAL_MS = 50;
const DEFAULT_MAX_RETRIES = 5;

type TelegramErrorLike = {
  response?: {
    error_code?: number;
    description?: string;
    parameters?: {
      retry_after?: number;
    };
  };
  description?: string;
  message?: string;
};

function asTelegramErrorLike(error: unknown): TelegramErrorLike | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  return error as TelegramErrorLike;
}

function extractRetryAfterSeconds(error: unknown): number | null {
  const telegramError = asTelegramErrorLike(error);
  const retryAfter = telegramError?.response?.parameters?.retry_after;

  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter;
  }

  const description = telegramError?.response?.description ?? telegramError?.description ?? telegramError?.message;
  if (typeof description !== 'string') {
    return null;
  }

  const match = description.match(/retry after\s+(\d+)/i);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isTelegramRateLimitError(error: unknown): boolean {
  const telegramError = asTelegramErrorLike(error);

  if (telegramError?.response?.error_code === 429) {
    return true;
  }

  return extractRetryAfterSeconds(error) !== null;
}

export class TelegramDeliveryService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly minIntervalMs: number = DEFAULT_MESSAGE_INTERVAL_MS,
    private readonly maxRetries: number = DEFAULT_MAX_RETRIES,
  ) {}

  async sendMessage(telegram: Telegram, chatId: string, text: string, options: Record<string, unknown> = {}): Promise<void> {
    return this.enqueue(async () => {
      let attempt = 0;

      while (true) {
        try {
          await telegram.sendMessage(chatId, text, options);
          await sleep(this.minIntervalMs);
          return;
        } catch (error) {
          attempt += 1;

          if (!isTelegramRateLimitError(error) || attempt > this.maxRetries) {
            throw error;
          }

          const retryAfterSeconds = extractRetryAfterSeconds(error) ?? 1;
          const waitMs = retryAfterSeconds * 1000;

          logger.warn('Telegram rate limited, retrying message delivery', {
            telegramId: chatId,
            attempt,
            retryAfterSeconds,
          });

          await sleep(waitMs);
        }
      }
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}
