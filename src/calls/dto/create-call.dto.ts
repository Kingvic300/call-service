import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { MeetingMode } from '../../interfaces/meeting-type.enum';

export class CreateCallDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  /** The caller — becomes the room's nominal owner, though 1:1 calls have no real host hierarchy. */
  @IsString()
  callerId!: string;

  @IsOptional()
  @IsEnum(MeetingMode)
  mode?: MeetingMode;
}
