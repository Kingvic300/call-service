import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TargetParticipantDto {
  @ApiProperty({ description: 'User id of the participant to act on.' })
  @IsString()
  targetUserId!: string;
}
