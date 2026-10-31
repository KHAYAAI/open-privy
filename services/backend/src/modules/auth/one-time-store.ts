import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createClient } from 'redis';
import { logger } from '../../common/logger';

/**
 * Short-lived, single-use values (mobile sign-in state and handoff codes).
 * Redis when REDIS_URL is set, so it works across replicas; an in-process
 * map otherwise (local development only). take() is atomic: a value can be
 * redeemed exactly once.
 */
@Injectable()
export class OneTimeStore implements OnModuleDestroy {
  private redis: ReturnType<typeof createClient> | null = null;
  private ready: Promise<void> | null = null;
  private memory = new Map<string, { value: string; expiresAt: number }>();

  constructor() {
    const url = process.env.REDIS_URL;
    if (url) {
      this.redis = createClient({ url });
      this.redis.on('error', (e) => logger.error(`OneTimeStore redis error: ${e.message}`));
      this.ready = this.redis.connect().then(() => undefined);
    } else if (process.env.NODE_ENV === 'production') {
      logger.warn('REDIS_URL not set: mobile sign-in codes are per-process (dev only)');
    }
  }

  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.redis) {
      await this.ready;
      await this.redis.set(`ots:${key}`, value, { EX: ttlSeconds, NX: true });
      return;
    }
    this.memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async take(key: string): Promise<string | null> {
    if (this.redis) {
      await this.ready;
      return (await this.redis.getDel(`ots:${key}`)) ?? null;
    }
    const entry = this.memory.get(key);
    this.memory.delete(key);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.value;
  }

  async onModuleDestroy() {
    if (this.redis?.isOpen) await this.redis.quit();
  }
}
