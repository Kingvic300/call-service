import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { MeetingModule } from '../meeting/meeting.module';

@Module({
  imports: [MeetingModule],
  controllers: [HealthController],
})
export class HealthModule {}
