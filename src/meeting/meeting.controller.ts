import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { MeetingType, MeetingMode } from '../interfaces/meeting-type.enum';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { MeetingService } from './meeting.service';

/**
 * Group calls and large standup meetings (500+ participants). 1:1 calls are
 * intentionally a separate, simpler REST surface under /calls — see
 * CallsController — since they have no host/moderation/chat concepts.
 */
@ApiTags('meetings')
@ApiSecurity('serviceApiKey')
@ApiSecurity('serviceSecretKey')
@Controller('meetings')
@UseGuards(ApiKeyGuard)
export class MeetingController {
  constructor(private readonly meetingService: MeetingService) {}

  @Post()
  @ApiOperation({ summary: 'Create a group meeting room' })
  @ApiResponse({ status: 201, description: "The created meeting's state." })
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
  @ApiOperation({ summary: "Get a meeting's current state" })
  @ApiParam({ name: 'id', description: 'Meeting id' })
  get(@Param('id') id: string) {
    return this.meetingService.getOrThrow(id).toStateJSON();
  }

  @Post(':id/end')
  @ApiOperation({ summary: 'End a meeting for all participants' })
  @ApiParam({ name: 'id', description: 'Meeting id' })
  end(@Param('id') id: string) {
    return this.meetingService.end(id, 'Ended by backend').toStateJSON();
  }

  @Delete(':id')
  @ApiOperation({ summary: "Remove a meeting's in-memory record" })
  @ApiParam({ name: 'id', description: 'Meeting id' })
  remove(@Param('id') id: string) {
    this.meetingService.delete(id);
    return { deleted: true };
  }
}
