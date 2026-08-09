import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Thin wrapper around the shared ioredis client(s) used for cross-instance
 * state (MeetingDirectoryService) and the Socket.IO Redis adapter (main.ts).
 * Everything here is `undefined` when REDIS_URL isn't set — every consumer
 * (MeetingDirectoryService, main.ts) treats that as "single-instance mode,
 * behave exactly like the service did before this module existed" rather
 * than branching on a separate feature flag.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client?: Redis;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');
    if (!url) return;

    this.client = new Redis(url, { lazyConnect: false });
    this.client.on('error', (err) => this.logger.error(`Redis client error: ${err.message}`));
    this.logger.log('Connected to Redis — multi-instance mode enabled');
  }

  get enabled(): boolean {
    return this.client !== undefined;
  }

  /**
   * The Socket.IO Redis adapter requires two dedicated connections distinct
   * from any connection used for regular commands — a subscriber connection
   * spends most of its life blocked inside Redis's pub/sub mode and can't
   * also serve GET/SET calls (see @socket.io/redis-adapter's docs).
   */
  createDuplicate(): Redis {
    if (!this.client) throw new Error('Redis is not configured (REDIS_URL unset)');
    return this.client.duplicate();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit();
  }
}
