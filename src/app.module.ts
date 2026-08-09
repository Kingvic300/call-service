import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { RedisModule } from './redis/redis.module';
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

@Module({
  imports: [
    AppConfigModule,
    RedisModule,
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
