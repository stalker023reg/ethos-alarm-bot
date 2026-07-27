import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosError } from 'axios';
import { config } from '../config/config';
import { RateLimiter, sleep } from '../utils/rateLimiter';
import { logger } from '../utils/logger';

/**
 * Low-level Axios client for Ethos Network API requests.
 * Includes rate limiting and automatic 429 retry with exponential backoff.
 */
export const ethosClient: AxiosInstance = axios.create({
  baseURL: config.ethos.baseUrl,
  headers: {
    'Content-Type': 'application/json',
    'X-Ethos-Client': config.ethos.clientHeader,
  },
  timeout: 15_000,
});

// Global rate limiter: max 10 requests per second
const rateLimiter = new RateLimiter(10);

// Request interceptor: throttle outgoing requests
ethosClient.interceptors.request.use(async (requestConfig) => {
  await rateLimiter.acquire();
  return requestConfig;
});

// Response interceptor: retry on 429 with exponential backoff
const MAX_RETRIES = 3;

ethosClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const cfg = error.config as AxiosRequestConfig & { _retryCount?: number };
    if (!cfg || error.response?.status !== 429) {
      return Promise.reject(error);
    }

    cfg._retryCount = (cfg._retryCount ?? 0) + 1;

    if (cfg._retryCount > MAX_RETRIES) {
      logger.warn('Ethos API rate limit exceeded after max retries', {
        url: cfg.url,
        retries: cfg._retryCount,
      });
      return Promise.reject(error);
    }

    // Respect Retry-After header if present, otherwise use exponential backoff
    const retryAfterHeader = error.response?.headers?.['retry-after'];
    const backoffMs = retryAfterHeader
      ? Number(retryAfterHeader) * 1000
      : 1000 * Math.pow(2, cfg._retryCount);

    logger.info('Ethos API 429, retrying', {
      url: cfg.url,
      retryIn: `${backoffMs}ms`,
      attempt: cfg._retryCount,
    });

    await sleep(backoffMs);
    return ethosClient(cfg);
  },
);

export interface EthosAuthOptions {
  privyToken?: string;
}

export function buildEthosRequestConfig(auth?: EthosAuthOptions): AxiosRequestConfig {
  if (!auth?.privyToken) {
    return {};
  }

  return {
    headers: {
      Authorization: `Bearer ${auth.privyToken}`,
    },
  };
}

