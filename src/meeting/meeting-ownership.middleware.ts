import { Inject, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { INSTANCE_CONFIG, InstanceAppConfig } from '../config/config.module';
import { MeetingDirectoryService } from './meeting-directory.service';
import { InstanceForwarderService } from './instance-forwarder.service';

/**
 * Applied to every controller keyed by a `:id` route param that is a
 * meetingId (MeetingController, ModerationController, CallsController — see
 * AppModule). Only that meeting's owning instance holds the live `Meeting`/
 * `Participant` objects (and their mediasoup transports/producers), so a
 * request that lands on any other instance is transparently forwarded
 * rather than handled against state that doesn't exist locally — this is
 * what makes e.g. `POST /meetings/:id/kick` work no matter which instance
 * the caller happens to hit.
 *
 * Runs as Express middleware (not a Nest interceptor) specifically because
 * it needs to short-circuit the response *before* the controller runs when
 * forwarding — middleware is the idiomatic Nest shape for "maybe handle
 * here, maybe hand off," an interceptor would have to fight Nest's own
 * response pipeline to do the same thing.
 */
@Injectable()
export class MeetingOwnershipMiddleware implements NestMiddleware {
  private readonly logger = new Logger(MeetingOwnershipMiddleware.name);

  constructor(
    private readonly meetingDirectory: MeetingDirectoryService,
    private readonly forwarder: InstanceForwarderService,
    @Inject(INSTANCE_CONFIG) private readonly instanceConfig: InstanceAppConfig,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const meetingId = req.params.id;
    if (!meetingId) {
      // No :id on this route (e.g. POST /meetings itself) — nothing to route.
      next();
      return;
    }

    const owner = await this.meetingDirectory.getOwner(meetingId);
    if (!owner || owner.instanceId === this.instanceConfig.instanceId) {
      // Redis absent (single-instance mode), no directory entry yet (let the
      // controller 404 as today), or we already own it — handle locally.
      next();
      return;
    }

    this.logger.debug(
      `Forwarding ${req.method} ${req.originalUrl} to owner ${owner.instanceId}`,
    );
    await this.forwarder.forward(owner.internalUrl, req, res);
  }
}
