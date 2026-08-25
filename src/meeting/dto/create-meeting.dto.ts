import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MeetingMode } from '../../interfaces/meeting-type.enum';

export class CreateMeetingDto {
  // Not a UUID: callers (e.g. NTeam's frontend) mint their own Meet/Zoom-style
  // room codes client-side and expect the room to be created under that exact
  // id — MeetingService.create() only ever uses `id` as an opaque Map key.
  @ApiPropertyOptional({ description: 'Defaults to a generated UUID if omitted.' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty({ description: 'User id of the meeting host.' })
  @IsString()
  hostId!: string;

  @ApiPropertyOptional({ enum: MeetingMode, default: MeetingMode.VIDEO })
  @IsOptional()
  @IsEnum(MeetingMode)
  mode?: MeetingMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  waitingRoomEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  chatEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  reactionsEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  screenShareEnabled?: boolean;
}
