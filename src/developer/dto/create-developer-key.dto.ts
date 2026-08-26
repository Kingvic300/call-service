import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDeveloperKeyDto {
  @ApiPropertyOptional({
    description:
      'A label for this credential. Defaults to an auto-generated one.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  serviceName?: string;
}
