import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as mediasoup from 'mediasoup';
import { types as mediasoupTypes } from 'mediasoup';
import { MEDIASOUP_CONFIG } from '../config/config.module';
import { MediasoupAppConfig } from '../config/mediasoup.config';

interface WorkerEntry {
  worker: mediasoupTypes.Worker;
  webRtcServer: mediasoupTypes.WebRtcServer;
  /** Number of routers (rooms) currently assigned to this worker. */
  routerCount: number;
}

/**
 * Owns the pool of mediasoup Workers (one OS process each) and hands out the
 * least-loaded worker for each new room/router — the CPU-aware allocation
 * strategy the spec calls for, since each mediasoup Worker is pinned to a
 * single CPU core. Also respawns workers that die unexpectedly so a single
 * crashed worker process doesn't take down the whole service (spec:
 * "Handle: Worker crashes").
 *
 * Each worker also gets its own WebRtcServer bound to
 * `MEDIASOUP_WEBRTC_PORT + workerIndex` (one UDP + one TCP listener) — every
 * WebRtcTransport created on that worker shares this single port instead of
 * each transport grabbing its own port from a large range. With the default
 * single-worker deployment (1 vCPU) that's exactly one port to open on a
 * firewall/Docker mapping. See docs/DEPLOYMENT.md.
 */
@Injectable()
export class WorkerPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerPoolService.name);
  private readonly entries = new Map<number, WorkerEntry>();

  constructor(@Inject(MEDIASOUP_CONFIG) private readonly config: MediasoupAppConfig) {}

  async onModuleInit(): Promise<void> {
    this.logger.log(`Starting ${this.config.numWorkers} mediasoup worker(s)`);
    // Sequential on purpose: each worker's WebRtcServer needs a distinct port
    // derived from its spawn index, so concurrent spawns would race on that
    // index. Worker+WebRtcServer startup is fast enough that this costs
    // nothing meaningful even at a few dozen workers.
    for (let index = 0; index < this.config.numWorkers; index += 1) {
      await this.spawnWorker(index);
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const { worker } of this.entries.values()) {
      worker.close(); // cascades: closes the worker's WebRtcServer, routers, transports, etc.
    }
    this.entries.clear();
  }

  /** Returns the worker currently hosting the fewest routers. */
  getLeastLoadedWorker(): mediasoupTypes.Worker {
    if (this.entries.size === 0) {
      throw new Error('No mediasoup workers available');
    }

    let best: WorkerEntry | undefined;
    for (const entry of this.entries.values()) {
      if (!best || entry.routerCount < best.routerCount) {
        best = entry;
      }
    }
    return best!.worker;
  }

  getWebRtcServer(worker: mediasoupTypes.Worker): mediasoupTypes.WebRtcServer {
    const entry = this.entries.get(worker.pid);
    if (!entry) throw new Error(`No WebRtcServer registered for worker ${worker.pid}`);
    return entry.webRtcServer;
  }

  /** Call after creating a router on `worker` so future allocations stay balanced. */
  registerRouterCreated(worker: mediasoupTypes.Worker): void {
    const entry = this.entries.get(worker.pid);
    if (entry) entry.routerCount += 1;
  }

  registerRouterClosed(worker: mediasoupTypes.Worker): void {
    const entry = this.entries.get(worker.pid);
    if (entry) entry.routerCount = Math.max(0, entry.routerCount - 1);
  }

  getStats(): Array<{ pid: number; routerCount: number }> {
    return Array.from(this.entries.values()).map((e) => ({
      pid: e.worker.pid,
      routerCount: e.routerCount,
    }));
  }

  get workerCount(): number {
    return this.entries.size;
  }

  private async spawnWorker(index: number): Promise<void> {
    const worker = await mediasoup.createWorker(this.config.worker);

    const listenInfos = this.config.webRtcServerListenInfos.map((info) => ({
      ...info,
      port: (info.port ?? 0) + index,
    }));
    const webRtcServer = await worker.createWebRtcServer({ listenInfos });

    worker.on('died', (error) => {
      this.logger.error(
        `mediasoup worker ${worker.pid} died unexpectedly, respawning: ${error.message}`,
      );
      this.entries.delete(worker.pid);
      // Fire-and-forget respawn; new rooms will land on the replacement.
      // Rooms already routed through the dead worker are unrecoverable and
      // must be rejoined by clients (mediasoup offers no live migration).
      void this.spawnWorker(index);
    });

    this.entries.set(worker.pid, { worker, webRtcServer, routerCount: 0 });
    this.logger.log(
      `mediasoup worker ${worker.pid} started (WebRtcServer port ${listenInfos[0]?.port})`,
    );
  }
}
