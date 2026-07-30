import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { MeetingType, MeetingMode } from '../interfaces/meeting-type.enum';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { MeetingService } from './meeting.service';

/**
 * Group calls and large standup meetings (500+ participants). 1:1 calls are
 * intentionally a separate, simpler REST surface under /calls — see
 * CallsController — since they have no host/moderation/chat concepts.
 */
@Controller('meetings')
@UseGuards(ApiKeyGuard)
export class MeetingController {
  constructor(private readonly meetingService: MeetingService) {}

  @Post()
  create(@Body() dto: CreateMeetingDto) {
    const meeting = this.meetingService.create({
      id: dto.id,
      hostId: dto.hostId,
      type: MeetingType.GROUP,
      mode: dto.mode ?? MeetingMode.VIDEO,
      waitingRoomEnabled: dto.waitingRoomEnabled,
      chatEnabled: dto.chatEnabled,
      reactionsEnabled: dto.reactionsEnabled,
      screenShareEnabled: dto.screenShareEnabled,
    });
    return meeting.toStateJSON();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.meetingService.getOrThrow(id).toStateJSON();
  }

  @Post(':id/end')
  end(@Param('id') id: string) {
    return this.meetingService.end(id, 'Ended by backend').toStateJSON();
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    this.meetingService.delete(id);
    return { deleted: true };
  }
}
