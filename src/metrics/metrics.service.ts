import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { WorkerPoolService } from '../workers/worker-pool.service';
import { MeetingService } from '../meeting/meeting.service';

@Injectable()
export class MetricsService {
  private readonly registry = new client.Registry();
  private readonly workersGauge: client.Gauge;
  private readonly routersGauge: client.Gauge;
  private readonly meetingsGauge: client.Gauge;
  private readonly participantsGauge: client.Gauge;

  constructor(
    private readonly workerPool: WorkerPoolService,
    private readonly meetingService: MeetingService,
  ) {
    client.collectDefaultMetrics({ register: this.registry });

    this.workersGauge = new client.Gauge({
      name: 'call_service_mediasoup_workers',
      help: 'Number of live mediasoup worker processes',
      registers: [this.registry],
    });
    this.routersGauge = new client.Gauge({
      name: 'call_service_mediasoup_routers',
      help: 'Number of active mediasoup routers (rooms with a live worker assignment)',
      registers: [this.registry],
    });
    this.meetingsGauge = new client.Gauge({
      name: 'call_service_active_meetings',
      help: 'Number of meetings currently in progress',
      registers: [this.registry],
    });
    this.participantsGauge = new client.Gauge({
      name: 'call_service_active_participants',
      help: 'Number of participants currently connected across all active meetings',
      registers: [this.registry],
    });
  }

  async getMetrics(): Promise<{ contentType: string; body: string }> {
    const workers = this.workerPool.getStats();
    const stats = this.meetingService.getStats();

    this.workersGauge.set(workers.length);
    this.routersGauge.set(workers.reduce((sum, w) => sum + w.routerCount, 0));
    this.meetingsGauge.set(stats.activeMeetings);
    this.participantsGauge.set(stats.totalParticipants);

    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    };
  }
}
