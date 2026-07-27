/**
 * Token-bucket rate limiter + batch-processing helper.
 * Ensures we never exceed a target request rate against the Ethos API.
 */

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Simple token-bucket rate limiter.
 * Call `acquire()` before every API request.
 * It will resolve immediately if tokens are available,
 * or wait until a token is refilled.
 */
export class RateLimiter {
    private tokens: number;
    private lastRefill: number;

    /**
     * @param maxPerSecond  Max requests per second (e.g. 10)
     */
    constructor(
        private readonly maxPerSecond: number,
    ) {
        this.tokens = maxPerSecond;
        this.lastRefill = Date.now();
    }

    async acquire(): Promise<void> {
        this.refill();

        if (this.tokens > 0) {
            this.tokens--;
            return;
        }

        // Wait until at least one token is available
        const waitMs = Math.ceil(1000 / this.maxPerSecond);
        await sleep(waitMs);
        this.refill();
        this.tokens = Math.max(0, this.tokens - 1);
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const newTokens = (elapsed / 1000) * this.maxPerSecond;
        this.tokens = Math.min(this.maxPerSecond, this.tokens + newTokens);
        this.lastRefill = now;
    }
}

/**
 * Process items in sequential batches with a delay between each batch.
 */
export async function processInBatches<T>(
    items: T[],
    batchSize: number,
    delayMs: number,
    handler: (item: T) => Promise<void>,
): Promise<void> {
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await Promise.all(batch.map(handler));

        // Delay between batches (skip after the last batch)
        if (i + batchSize < items.length) {
            await sleep(delayMs);
        }
    }
}

export { sleep };
