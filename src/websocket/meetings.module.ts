import { Module } from '@nestjs/common';
import { MeetingsGateway } from './meetings.gateway';
import { WebsocketCoreModule } from './websocket-core.module';
import { MeetingModule } from '../meeting/meeting.module';
import { ParticipantModule } from '../participant/participant.module';
import { ChatModule } from '../chat/chat.module';
import { ReactionsModule } from '../reactions/reactions.module';
import { ModerationModule } from '../moderation/moderation.module';

@Module({
  imports: [
    WebsocketCoreModule,
    MeetingModule,
    ParticipantModule,
    ChatModule,
    ReactionsModule,
    ModerationModule,
  ],
  providers: [MeetingsGateway],
})
export class MeetingsModule {}
