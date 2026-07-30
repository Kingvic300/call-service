import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config';
import { buildMediasoupConfig, MediasoupAppConfig } from './mediasoup.config';
import { validateEnv } from './env.validation';

export const MEDIASOUP_CONFIG = 'MEDIASOUP_CONFIG';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: ['.env'],
    }),
  ],
  providers: [
    {
      provide: MEDIASOUP_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MediasoupAppConfig => buildMediasoupConfig(config),
    },
  ],
  exports: [MEDIASOUP_CONFIG],
})
export class AppConfigModule {}
