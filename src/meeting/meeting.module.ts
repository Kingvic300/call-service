import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { MeetingService } from './meeting.service';
import { MeetingController } from './meeting.controller';
import { InMemoryMeetingRepository, MEETING_REPOSITORY } from './meeting.repository';
import { MeetingDirectoryService } from './meeting-directory.service';
import { InstanceForwarderService } from './instance-forwarder.service';
import { MeetingOwnershipMiddleware } from './meeting-ownership.middleware';
import { WaitingRoomService } from './waiting-room.service';

@Module({
  imports: [ChatModule],
  controllers: [MeetingController],
  providers: [
    MeetingService,
    WaitingRoomService,
    MeetingDirectoryService,
    InstanceForwarderService,
    MeetingOwnershipMiddleware,
    { provide: MEETING_REPOSITORY, useClass: InMemoryMeetingRepository },
  ],
  exports: [
    MeetingService,
    WaitingRoomService,
    MEETING_REPOSITORY,
    MeetingDirectoryService,
    InstanceForwarderService,
    MeetingOwnershipMiddleware,
  ],
})
export class MeetingModule {}
