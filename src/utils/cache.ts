/**
 * Simple in-memory TTL cache to reduce redundant Ethos API calls.
 */
export class TtlCache<T> {
    private readonly store = new Map<string, { value: T; expiresAt: number }>();

    constructor(private readonly ttlMs: number) { }

    get(key: string): T | undefined {
        const entry = this.store.get(key);
        if (!entry) return undefined;

        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return undefined;
        }

        return entry.value;
    }

    set(key: string, value: T): void {
        this.store.set(key, {
            value,
            expiresAt: Date.now() + this.ttlMs,
        });
    }

    invalidate(key: string): void {
        this.store.delete(key);
    }

    clear(): void {
        this.store.clear();
    }

    /** Remove expired entries to prevent memory leaks */
    prune(): void {
        const now = Date.now();
        for (const [key, entry] of this.store) {
            if (now > entry.expiresAt) {
                this.store.delete(key);
            }
        }
    }

    get size(): number {
        return this.store.size;
    }
}
