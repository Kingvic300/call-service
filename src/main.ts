import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RedisService } from './redis/redis.service';
import { RedisIoAdapter } from './websocket/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.use(helmet());
  app.enableCors({ origin: config.get<string>('CORS_ORIGIN', '*'), credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  // Multi-instance mode: fans Socket.IO broadcasts (RealtimeBroadcaster's
  // .to(room).emit(...) calls) out across every instance subscribed to the
  // same Redis, not just sockets connected to this process. No-ops (regular
  // in-memory Socket.IO adapter) when REDIS_URL is unset — single-instance
  // behavior is unchanged. See docs/INTEGRATION.md "Multi-instance
  // deployment".
  const redis = app.get(RedisService);
  if (redis.enabled) {
    const redisIoAdapter = new RedisIoAdapter(app);
    await redisIoAdapter.connectToRedis(redis);
    app.useWebSocketAdapter(redisIoAdapter);
    logger.log('Socket.IO Redis adapter attached — multi-instance signaling enabled');
  }

  const port = config.get<number>('PORT', 4000);
  await app.listen(port, '0.0.0.0');
  logger.log(`call-service listening on :${port} (/calls and /meetings namespaces)`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during bootstrap', err);
  process.exit(1);
});
