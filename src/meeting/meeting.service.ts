import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { types as mediasoupTypes } from 'mediasoup';
import { RouterManagerService } from '../mediasoup/router-manager.service';
import { RealtimeBroadcaster } from '../websocket/realtime-broadcaster.service';
import { ChatService } from '../chat/chat.service';
import { MeetingMode, MeetingType } from '../interfaces/meeting-type.enum';
import { ServerEvent } from '../interfaces/socket-events.enum';
import { INSTANCE_CONFIG, InstanceAppConfig } from '../config/config.module';
import { Meeting } from './entities/meeting.entity';
import { IMeetingRepository, MEETING_REPOSITORY } from './meeting.repository';
import { MeetingDirectoryService } from './meeting-directory.service';

// How long an ended meeting's record stays readable via GET /meetings/:id
// (e.g. for a caller fetching final state right after end) before its
// in-memory record is dropped. Without this, InMemoryMeetingRepository grows
// by one permanent entry per meeting/call ever completed, for the life of
// the process — and getStats() (polled by /health + /metrics roughly twice
// a minute) does a full scan of that ever-growing map on every call.
const ENDED_MEETING_RETENTION_MS = 5 * 60_000;

export interface CreateMeetingParams {
  id?: string;
  hostId: string;
  type: MeetingType;
  mode: MeetingMode;
  waitingRoomEnabled?: boolean;
  chatEnabled?: boolean;
  reactionsEnabled?: boolean;
  screenShareEnabled?: boolean;
}

@Injectable()
export class MeetingService {
  private readonly logger = new Logger(MeetingService.name);

  constructor(
    @Inject(MEETING_REPOSITORY) private readonly repository: IMeetingRepository,
    @Inject(INSTANCE_CONFIG) private readonly instanceConfig: InstanceAppConfig,
    private readonly routerManager: RouterManagerService,
    private readonly broadcaster: RealtimeBroadcaster,
    private readonly chatService: ChatService,
    private readonly meetingDirectory: MeetingDirectoryService,
  ) {}

  create(params: CreateMeetingParams): Meeting {
    const id = params.id ?? uuidv4();
    if (this.repository.findById(id)) {
      throw new BadRequestException(`Meeting ${id} already exists`);
    }

    const meeting = new Meeting({
      id,
      hostId: params.hostId,
      type: params.type,
      mode: params.mode,
      waitingRoomEnabled: params.waitingRoomEnabled,
      chatEnabled: params.chatEnabled,
      reactionsEnabled: params.reactionsEnabled,
      screenShareEnabled: params.screenShareEnabled,
    });
    meeting.ownerInternalUrl = this.instanceConfig.internalUrl;

    this.repository.save(meeting);
    // This instance is the meeting's owner for the lifetime of its router —
    // fire-and-forget (Redis absent or unreachable must never block/fail
    // meeting creation itself, only cross-instance routing).
    this.meetingDirectory
      .registerOwnership(id, this.instanceConfig)
      .catch((err: Error) =>
        this.logger.warn(
          `Failed to register ownership for ${id}: ${err.message}`,
        ),
      );
    this.logger.log(
      `Meeting ${id} created (type=${params.type}, host=${params.hostId})`,
    );
    return meeting;
  }

  getOrThrow(id: string): Meeting {
    const meeting = this.repository.findById(id);
    if (!meeting) throw new NotFoundException(`Meeting ${id} not found`);
    return meeting;
  }

  find(id: string): Meeting | undefined {
    return this.repository.findById(id);
  }

  async getOrCreateRouter(meeting: Meeting): Promise<mediasoupTypes.Router> {
    return this.routerManager.getOrCreateRouter(meeting.id);
  }

  /** Ends a live meeting: disconnects every participant and tears down its router. Idempotent. */
  end(id: string, reason = 'Meeting ended'): Meeting {
    const meeting = this.getOrThrow(id);
    if (meeting.isEnded) return meeting;

    meeting.endedAt = new Date();

    this.broadcaster.emitToMeeting(
      meeting.namespace,
      meeting.id,
      ServerEvent.MEETING_ENDED,
      {
        meetingId: id,
        reason,
      },
    );
    for (const participant of meeting.participants.values()) {
      participant.closeAllMedia();
      // Deferred: if the caller of end() is itself a socket handler (e.g. the
      // host's own `endMeeting` event), disconnecting synchronously here would
      // tear down that same socket before Nest can flush its ack response —
      // the host would never see their own "end meeting" action confirmed.
      // setImmediate lets the current handler's return value go out first.
      const namespace = meeting.namespace;
      const socketId = participant.socketId;
      setImmediate(() =>
        this.broadcaster.disconnectSocket(namespace, socketId),
      );
    }
    meeting.participants.clear();
    meeting.waitingParticipants.clear();

    this.routerManager.closeRouter(id);
    // Chat history is kept in its own per-meeting buffer (see ChatService)
    // for the meeting's whole (unbounded) lifetime — without this, every
    // meeting that's ever run leaves its history entry behind forever, a
    // slow, permanent leak for a long-running server.
    this.chatService.clearHistory(id);
    this.meetingDirectory
      .clearOwnership(id)
      .catch((err: Error) =>
        this.logger.warn(`Failed to clear ownership for ${id}: ${err.message}`),
      );
    this.logger.log(`Meeting ${id} ended: ${reason}`);

    const timer = setTimeout(() => {
      // Guard: a caller may have already hard-deleted (or recreated with the
      // same id, in the unlikely event it was reused) in the meantime.
      const current = this.repository.findById(id);
      if (current === meeting) this.repository.delete(id);
    }, ENDED_MEETING_RETENTION_MS);
    timer.unref();

    return meeting;
  }

  /** Hard-deletes a meeting record (e.g. a scheduled meeting cancelled before it ever started). */
  delete(id: string): void {
    const meeting = this.repository.findById(id);
    if (!meeting) return;
    if (!meeting.isEnded) this.end(id, 'Meeting deleted');
    this.repository.delete(id);
  }

  /** Used by the /metrics endpoint — not exposed over the public REST API. */
  getStats(): {
    totalMeetings: number;
    activeMeetings: number;
    totalParticipants: number;
  } {
    const all = this.repository.list();
    const active = all.filter((m) => !m.isEnded);
    const totalParticipants = active.reduce(
      (sum, m) => sum + m.participantCount,
      0,
    );
    return {
      totalMeetings: all.length,
      activeMeetings: active.length,
      totalParticipants,
    };
  }

  broadcastStateUpdate(meeting: Meeting): void {
    this.broadcaster.emitToMeeting(
      meeting.namespace,
      meeting.id,
      ServerEvent.MEETING_STATE_UPDATED,
      meeting.toStateJSON(),
    );
  }
}
