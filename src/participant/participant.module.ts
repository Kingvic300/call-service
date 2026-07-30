import { Module } from '@nestjs/common';
import { ParticipantService } from './participant.service';
import { ParticipantController } from './participant.controller';
import { MeetingModule } from '../meeting/meeting.module';

@Module({
  imports: [MeetingModule],
  controllers: [ParticipantController],
  providers: [ParticipantService],
  exports: [ParticipantService],
})
export class ParticipantModule {}
