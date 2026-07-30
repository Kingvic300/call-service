import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { MeetingModule } from '../meeting/meeting.module';

@Module({
  imports: [MeetingModule],
  controllers: [MetricsController],
  providers: [MetricsService],
})
export class MetricsModule {}
