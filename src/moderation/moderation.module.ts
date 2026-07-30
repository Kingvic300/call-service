import { Module } from '@nestjs/common';
import { ModerationService } from './moderation.service';
import { ModerationController } from './moderation.controller';
import { ParticipantModule } from '../participant/participant.module';
import { ScreenShareModule } from '../screen-share/screen-share.module';
import { MeetingModule } from '../meeting/meeting.module';

@Module({
  imports: [ParticipantModule, ScreenShareModule, MeetingModule],
  controllers: [ModerationController],
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}
