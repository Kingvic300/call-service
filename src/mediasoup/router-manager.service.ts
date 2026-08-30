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
  /** In-flight router creations, keyed by meetingId — see getOrCreateRouter. */
  private readonly pendingRooms = new Map<
    string,
    Promise<mediasoupTypes.Router>
  >();

  constructor(
    private readonly workerPool: WorkerPoolService,
    @Inject(MEDIASOUP_CONFIG) private readonly config: MediasoupAppConfig,
  ) {
    super();
    this.setMaxListeners(0);
  }

  /**
   * Two participants joining the same brand-new meeting within the same
   * tick (e.g. a group meeting where several invitees click "join" around
   * the same time) both used to see `this.rooms.get(meetingId)` as
   * undefined and race to create their own router — the second `rooms.set`
   * silently overwrote the first, leaking that worker's router/observer
   * forever, and worse, splitting the meeting across two disjoint SFU
   * routers that can't relay media to each other (some participants join
   * transports on the orphaned first router, others on the second — they'd
   * never see or hear one another despite both being "in" the meeting).
   * Memoizing the in-flight promise makes every concurrent caller await the
   * same creation, mirroring the client's ensureSendTransport/
   * ensureRecvTransport fix for the identical race on the frontend.
   */
  async getOrCreateRouter(meetingId: string): Promise<mediasoupTypes.Router> {
    const existing = this.rooms.get(meetingId);
    if (existing) return existing.router;

    const pending = this.pendingRooms.get(meetingId);
    if (pending) return pending;

    const creation = this.createRoom(meetingId).finally(() => {
      this.pendingRooms.delete(meetingId);
    });
    this.pendingRooms.set(meetingId, creation);
    return creation;
  }

  private async createRoom(meetingId: string): Promise<mediasoupTypes.Router> {
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
      this.emit('activeSpeaker', {
        meetingId,
        peerId: null,
      } satisfies ActiveSpeakerEvent);
    });

    this.rooms.set(meetingId, { router, worker, audioLevelObserver });
    this.logger.log(
      `Router created for meeting ${meetingId} on worker ${worker.pid}`,
    );
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
