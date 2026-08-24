import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MeetingMode } from '../../interfaces/meeting-type.enum';

export class CreateMeetingDto {
  @ApiPropertyOptional({ description: 'Defaults to a generated UUID if omitted.' })
  @IsOptional()
  @IsUUID()
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
