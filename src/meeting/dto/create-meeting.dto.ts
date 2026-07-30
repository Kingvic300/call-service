import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { MeetingMode } from '../../interfaces/meeting-type.enum';

export class CreateMeetingDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  hostId!: string;

  @IsOptional()
  @IsEnum(MeetingMode)
  mode?: MeetingMode;

  @IsOptional()
  @IsBoolean()
  waitingRoomEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  chatEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  reactionsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  screenShareEnabled?: boolean;
}
