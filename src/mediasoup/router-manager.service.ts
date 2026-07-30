import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { types as mediasoupTypes } from 'mediasoup';
import { MEDIASOUP_CONFIG } from '../config/config.module';
import { MediasoupAppConfig } from '../config/mediasoup.config';
import { WorkerPoolService } from '../workers/worker-pool.service';
import { ActiveSpeakerEvent } from './types';

interface RoomMediaContext {
  router: mediasoupTypes.Router;
  worker: mediasoupTypes.Worker;
  audioLevelObserver: mediasoupTypes.AudioLevelObserver;
}

/**
 * Owns one mediasoup Router per meeting (room), each pinned to whichever
 * worker WorkerPoolService judges least loaded at creation time. Also wires
 * up per-room active-speaker detection via mediasoup's AudioLevelObserver
 * (spec: "Active speaker detection").
 */
@Injectable()
export class RouterManagerService extends EventEmitter {
  private readonly logger = new Logger(RouterManagerService.name);
  private readonly rooms = new Map<string, RoomMediaContext>();

  constructor(
    private readonly workerPool: WorkerPoolService,
    @Inject(MEDIASOUP_CONFIG) private readonly config: MediasoupAppConfig,
  ) {
    super();
    this.setMaxListeners(0);
  }

  async getOrCreateRouter(meetingId: string): Promise<mediasoupTypes.Router> {
    const existing = this.rooms.get(meetingId);
    if (existing) return existing.router;

    const worker = this.workerPool.getLeastLoadedWorker();
    const router = await worker.createRouter(this.config.router);
    this.workerPool.registerRouterCreated(worker);

    const audioLevelObserver = await router.createAudioLevelObserver({
      maxEntries: 1,
      threshold: -70,
      interval: 800,
    });

    audioLevelObserver.on('volumes', (volumes) => {
      const [dominant] = volumes;
      if (dominant) {
        const event: ActiveSpeakerEvent = {
          meetingId,
          peerId: (dominant.producer.appData.peerId as string) ?? null,
          volume: dominant.volume,
        };
        this.emit('activeSpeaker', event);
      }
    });
    audioLevelObserver.on('silence', () => {
      this.emit('activeSpeaker', { meetingId, peerId: null } satisfies ActiveSpeakerEvent);
    });

    this.rooms.set(meetingId, { router, worker, audioLevelObserver });
    this.logger.log(`Router created for meeting ${meetingId} on worker ${worker.pid}`);
    return router;
  }

  getRouter(meetingId: string): mediasoupTypes.Router | undefined {
    return this.rooms.get(meetingId)?.router;
  }

  /** The shared WebRtcServer for whichever worker hosts this meeting's router. */
  getWebRtcServer(meetingId: string): mediasoupTypes.WebRtcServer | undefined {
    const room = this.rooms.get(meetingId);
    if (!room) return undefined;
    return this.workerPool.getWebRtcServer(room.worker);
  }

  async addProducerToAudioLevelObserver(
    meetingId: string,
    producer: mediasoupTypes.Producer,
  ): Promise<void> {
    if (producer.kind !== 'audio') return;
    const room = this.rooms.get(meetingId);
    if (!room) return;
    await room.audioLevelObserver.addProducer({ producerId: producer.id });
  }

  closeRouter(meetingId: string): void {
    const room = this.rooms.get(meetingId);
    if (!room) return;

    room.audioLevelObserver.close();
    room.router.close();
    this.workerPool.registerRouterClosed(room.worker);
    this.rooms.delete(meetingId);
    this.logger.log(`Router closed for meeting ${meetingId}`);
  }

  hasRoom(meetingId: string): boolean {
    return this.rooms.has(meetingId);
  }
}
