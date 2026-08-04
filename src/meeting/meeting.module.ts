import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { MeetingService } from './meeting.service';
import { MeetingController } from './meeting.controller';
import { InMemoryMeetingRepository, MEETING_REPOSITORY } from './meeting.repository';
import { WaitingRoomService } from './waiting-room.service';

@Module({
  imports: [ChatModule],
  controllers: [MeetingController],
  providers: [
    MeetingService,
    WaitingRoomService,
    { provide: MEETING_REPOSITORY, useClass: InMemoryMeetingRepository },
  ],
  exports: [MeetingService, WaitingRoomService, MEETING_REPOSITORY],
})
export class MeetingModule {}
