import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { MeetingService } from '../meeting/meeting.service';
import { ParticipantService } from './participant.service';

@ApiTags('participants')
@ApiSecurity('serviceApiKey')
@ApiSecurity('serviceSecretKey')
@Controller('participants')
@UseGuards(ApiKeyGuard)
export class ParticipantController {
  constructor(
    private readonly meetingService: MeetingService,
    private readonly participants: ParticipantService,
  ) {}

  @Get(':meetingId')
  @ApiOperation({ summary: "List a meeting's current participants" })
  @ApiParam({ name: 'meetingId', description: 'Meeting id' })
  list(@Param('meetingId') meetingId: string) {
    const meeting = this.meetingService.getOrThrow(meetingId);
    return this.participants.list(meeting).map((p) => p.toPublicJSON());
  }
}
