import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { MeetingService } from '../meeting/meeting.service';
import { TargetParticipantDto } from '../meeting/dto/target-participant.dto';
import { ModerationActor, ModerationService } from './moderation.service';

/**
 * Backend-triggered moderation actions (POST /meetings/:id/mute, /kick, ...).
 * Callers here are the trusted NestJS backend (already authenticated the
 * end-user and checked their host/moderator permission on its own side), so
 * these bypass ModerationService's live-role permission check — that check
 * still applies to the equivalent socket events a client can emit directly
 * from a live meeting (see MeetingsGateway).
 */
const TRUSTED_ACTOR: ModerationActor = { role: 'trusted' };

@ApiTags('moderation')
@ApiSecurity('serviceApiKey')
@ApiParam({ name: 'id', description: 'Meeting id' })
@Controller('meetings/:id')
@UseGuards(ApiKeyGuard)
export class ModerationController {
  constructor(
    private readonly meetingService: MeetingService,
    private readonly moderation: ModerationService,
  ) {}

  @Post('mute')
  @ApiOperation({ summary: 'Mute a participant' })
  async mute(@Param('id') id: string, @Body() dto: TargetParticipantDto) {
    const meeting = this.meetingService.getOrThrow(id);
    await this.moderation.muteParticipant(meeting, TRUSTED_ACTOR, dto.targetUserId);
    return { muted: dto.targetUserId };
  }

  @Post('kick')
  @ApiOperation({ summary: 'Remove a participant (alias of remove)' })
  kick(@Param('id') id: string, @Body() dto: TargetParticipantDto) {
    return this.remove(id, dto);
  }

  @Post('remove')
  @ApiOperation({ summary: 'Remove a participant from the meeting' })
  remove(@Param('id') id: string, @Body() dto: TargetParticipantDto) {
    const meeting = this.meetingService.getOrThrow(id);
    this.moderation.removeParticipant(meeting, TRUSTED_ACTOR, dto.targetUserId);
    return { removed: dto.targetUserId };
  }

  @Post('promote')
  @ApiOperation({ summary: 'Promote a participant to co-host' })
  promote(@Param('id') id: string, @Body() dto: TargetParticipantDto) {
    const meeting = this.meetingService.getOrThrow(id);
    this.moderation.promote(meeting, TRUSTED_ACTOR, dto.targetUserId);
    return { promoted: dto.targetUserId };
  }

  @Post('demote')
  @ApiOperation({ summary: 'Demote a co-host back to participant' })
  demote(@Param('id') id: string, @Body() dto: TargetParticipantDto) {
    const meeting = this.meetingService.getOrThrow(id);
    this.moderation.demote(meeting, TRUSTED_ACTOR, dto.targetUserId);
    return { demoted: dto.targetUserId };
  }

  @Post('lock')
  @ApiOperation({ summary: 'Lock the meeting against new joins' })
  lock(@Param('id') id: string) {
    const meeting = this.meetingService.getOrThrow(id);
    this.moderation.setLocked(meeting, TRUSTED_ACTOR, true);
    return { locked: true };
  }

  @Post('unlock')
  @ApiOperation({ summary: 'Unlock the meeting' })
  unlock(@Param('id') id: string) {
    const meeting = this.meetingService.getOrThrow(id);
    this.moderation.setLocked(meeting, TRUSTED_ACTOR, false);
    return { locked: false };
  }
}
