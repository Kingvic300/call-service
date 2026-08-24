import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MeetingMode } from '../../interfaces/meeting-type.enum';

export class CreateCallDto {
  @ApiPropertyOptional({ description: 'Defaults to a generated UUID if omitted.' })
  @IsOptional()
  @IsUUID()
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
