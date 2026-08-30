import { Module } from '@nestjs/common';
import { SignalingService } from './signaling.service';
import { ConnectionGuardService } from './connection-guard.service';
import { MeetingModule } from '../meeting/meeting.module';
import { ParticipantModule } from '../participant/participant.module';
import { ScreenShareModule } from '../screen-share/screen-share.module';
import { ChatModule } from '../chat/chat.module';
import { ReactionsModule } from '../reactions/reactions.module';

/**
 * Shared signaling core (mediasoup orchestration + connection auth/rate
 * limiting) consumed by both CallsModule (/calls) and MeetingsModule
 * (/meetings). RealtimeBroadcaster/mediasoup services are @Global so they
 * don't need to be imported here explicitly.
 */
@Module({
  imports: [
    MeetingModule,
    ParticipantModule,
    ScreenShareModule,
    ChatModule,
    ReactionsModule,
  ],
  providers: [SignalingService, ConnectionGuardService],
  exports: [SignalingService, ConnectionGuardService],
})
export class WebsocketCoreModule {}
