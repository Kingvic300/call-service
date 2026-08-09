import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { RedisService } from '../redis/redis.service';

/**
 * Attaches the Socket.IO Redis adapter to the single underlying `Server`
 * Nest creates — CallsGateway (/calls) and MeetingsGateway (/meetings) each
 * derive their namespace from `.of(...)` on that same Server, so both
 * inherit this adapter automatically, no per-gateway wiring needed.
 *
 * Requires two dedicated ioredis connections (see RedisService.createDuplicate)
 * distinct from any connection used for regular GET/SET — a subscriber
 * connection spends most of its life blocked in Redis's pub/sub mode.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(redis: RedisService): Promise<void> {
    const pubClient = redis.createDuplicate();
    const subClient = redis.createDuplicate();
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
