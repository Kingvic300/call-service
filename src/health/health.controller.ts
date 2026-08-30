import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { WorkerPoolService } from '../workers/worker-pool.service';
import { MeetingService } from '../meeting/meeting.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly workerPool: WorkerPoolService,
    private readonly meetingService: MeetingService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Service health, mediasoup worker stats, and meeting counts',
  })
  check() {
    const workers = this.workerPool.getStats();
    const healthy = workers.length > 0;

    return {
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor(process.uptime()),
      mediasoup: {
        workerCount: workers.length,
        workers,
      },
      meetings: this.meetingService.getStats(),
    };
  }
}
