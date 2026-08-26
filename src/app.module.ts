import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AppConfigModule } from './config/config.module';
import { RedisModule } from './redis/redis.module';
import { CredentialsModule } from './credentials/credentials.module';
import { AuthModule } from './auth/auth.module';
import { WorkerPoolModule } from './workers/worker-pool.module';
import { MediasoupModule } from './mediasoup/mediasoup.module';
import { RealtimeBroadcasterModule } from './websocket/realtime-broadcaster.module';
import { CoturnModule } from './coturn/coturn.module';
import { MeetingModule } from './meeting/meeting.module';
import { ParticipantModule } from './participant/participant.module';
import { ChatModule } from './chat/chat.module';
import { ReactionsModule } from './reactions/reactions.module';
import { ScreenShareModule } from './screen-share/screen-share.module';
import { ModerationModule } from './moderation/moderation.module';
import { CallsModule } from './calls/calls.module';
import { MeetingsModule } from './websocket/meetings.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { MeetingOwnershipMiddleware } from './meeting/meeting-ownership.middleware';
import { MeetingController } from './meeting/meeting.controller';
import { ModerationController } from './moderation/moderation.controller';
import { CallsController } from './calls/calls.controller';
import { DeveloperModule } from './developer/developer.module';

@Module({
  imports: [
    // The Naelix marketing/developer page (public/index.html) — served at
    // `/` so it's the app's entry point. Registered before every API module
    // below is mostly cosmetic (Nest routes by path, not registration
    // order), but keeps "what a browser hits first" readable at a glance.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
    }),
    AppConfigModule,
    RedisModule,
    CredentialsModule,
    AuthModule,
    WorkerPoolModule,
    MediasoupModule,
    RealtimeBroadcasterModule,
    CoturnModule,
    MeetingModule,
    ParticipantModule,
    ChatModule,
    ReactionsModule,
    ScreenShareModule,
    ModerationModule,
    CallsModule,
    MeetingsModule,
    HealthModule,
    MetricsModule,
    DeveloperModule,
  ],
})
export class AppModule implements NestModule {
  /**
   * Every controller keyed by a `:id` route param that's a meetingId needs
   * MeetingOwnershipMiddleware in front of it — see that class's doc
   * comment. No-op in single-instance mode (Redis absent).
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(MeetingOwnershipMiddleware)
      .forRoutes(MeetingController, ModerationController, CallsController);
  }
}
