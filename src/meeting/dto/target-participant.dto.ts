import { IsString } from 'class-validator';

export class TargetParticipantDto {
  @IsString()
  targetUserId!: string;
}
