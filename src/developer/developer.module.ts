import { Module } from '@nestjs/common';
import { DeveloperController } from './developer.controller';

@Module({
  controllers: [DeveloperController],
})
export class DeveloperModule {}
