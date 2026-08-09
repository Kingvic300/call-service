import { Global, Module } from '@nestjs/common';
import { hostname } from 'os';
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config';
import { buildMediasoupConfig, MediasoupAppConfig } from './mediasoup.config';
import { validateEnv } from './env.validation';

export const MEDIASOUP_CONFIG = 'MEDIASOUP_CONFIG';
export const INSTANCE_CONFIG = 'INSTANCE_CONFIG';

export interface InstanceAppConfig {
  /** Stable identifier for this process — used as the value stored in the
   *  Redis meeting-ownership directory (see MeetingDirectoryService). */
  instanceId: string;
  /** Base URL other instances use to reach this one (REST forwarding) and
   *  that clients use to open their Socket.IO connection against the
   *  meeting's actual owner. See env.validation.ts for the production
   *  override requirement. */
  internalUrl: string;
}

function buildInstanceConfig(config: ConfigService): InstanceAppConfig {
  const port = config.get<number>('PORT', 4000);
  return {
    instanceId: config.get<string>('INSTANCE_ID') ?? `${hostname()}-${process.pid}`,
    internalUrl: config.get<string>('INSTANCE_INTERNAL_URL') ?? `http://127.0.0.1:${port}`,
  };
}

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
    {
      provide: INSTANCE_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): InstanceAppConfig => buildInstanceConfig(config),
    },
  ],
  exports: [MEDIASOUP_CONFIG, INSTANCE_CONFIG],
})
export class AppConfigModule {}
