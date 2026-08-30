import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MeetingMode } from '../../interfaces/meeting-type.enum';

export class CreateCallDto {
  // Not a UUID: callers (e.g. NTeam's frontend) mint their own Meet/Zoom-style
  // room codes client-side and expect the room to be created under that exact
  // id — MeetingService.create() only ever uses `id` as an opaque Map key.
  @ApiPropertyOptional({
    description: 'Defaults to a generated UUID if omitted.',
  })
  @IsOptional()
  @IsString()
  id?: string;

  /** The caller — becomes the room's nominal owner, though 1:1 calls have no real host hierarchy. */
  @ApiProperty({ description: 'User id of the caller.' })
  @IsString()
  callerId!: string;

  @ApiPropertyOptional({ enum: MeetingMode, default: MeetingMode.VIDEO })
  @IsOptional()
  @IsEnum(MeetingMode)
  mode?: MeetingMode;
}
