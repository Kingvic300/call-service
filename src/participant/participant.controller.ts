import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { MeetingService } from '../meeting/meeting.service';
import { ParticipantService } from './participant.service';

@Controller('participants')
@UseGuards(ApiKeyGuard)
export class ParticipantController {
  constructor(
    private readonly meetingService: MeetingService,
    private readonly participants: ParticipantService,
  ) {}

  @Get(':meetingId')
  list(@Param('meetingId') meetingId: string) {
    const meeting = this.meetingService.getOrThrow(meetingId);
    return this.participants.list(meeting).map((p) => p.toPublicJSON());
  }
}
