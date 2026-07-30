import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';

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

  const port = config.get<number>('PORT', 4000);
  await app.listen(port, '0.0.0.0');
  logger.log(`call-service listening on :${port} (/calls and /meetings namespaces)`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during bootstrap', err);
  process.exit(1);
});
