import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { MeetingType, MeetingMode } from '../interfaces/meeting-type.enum';
import { MeetingService } from '../meeting/meeting.service';
import { CreateCallDto } from './dto/create-call.dto';

/**
 * 1:1 audio/video calls. Deliberately a much smaller REST surface than
 * /meetings — no kick/mute/promote/lock, since a 2-person call has no
 * moderation concept (see CallsGateway for the matching socket namespace).
 */
@ApiTags('calls')
@ApiSecurity('serviceApiKey')
@ApiSecurity('serviceSecretKey')
@Controller('calls')
@UseGuards(ApiKeyGuard)
export class CallsController {
  constructor(private readonly meetingService: MeetingService) {}

  @Post()
  @ApiOperation({ summary: 'Create a 1:1 call room' })
  @ApiResponse({ status: 201, description: "The created call's state." })
  create(@Body() dto: CreateCallDto) {
    const call = this.meetingService.create({
      id: dto.id,
      hostId: dto.callerId,
      type: MeetingType.ONE_TO_ONE,
      mode: dto.mode ?? MeetingMode.VIDEO,
    });
    return call.toStateJSON();
  }

  @Get(':id')
  @ApiOperation({ summary: "Get a call's current state" })
  @ApiParam({ name: 'id', description: 'Call id' })
  get(@Param('id') id: string) {
    return this.meetingService.getOrThrow(id).toStateJSON();
  }

  @Post(':id/end')
  @ApiOperation({ summary: 'End a call for both participants' })
  @ApiParam({ name: 'id', description: 'Call id' })
  end(@Param('id') id: string) {
    return this.meetingService.end(id, 'Ended by backend').toStateJSON();
  }
}
