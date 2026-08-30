import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';
import { types as mediasoupTypes } from 'mediasoup';
import { MeetingService } from '../meeting/meeting.service';
import { WaitingRoomService } from '../meeting/waiting-room.service';
import { MeetingDirectoryService } from '../meeting/meeting-directory.service';
import { Meeting } from '../meeting/entities/meeting.entity';
import { Participant } from '../participant/entities/participant.entity';
import { ParticipantService } from '../participant/participant.service';
import { RouterManagerService } from '../mediasoup/router-manager.service';
import { TransportService } from '../mediasoup/transport.service';
import { ProducerConsumerService } from '../mediasoup/producer-consumer.service';
import { TransportDirection } from '../mediasoup/types';
import {
  ScreenShareService,
  isScreenShareProducer,
} from '../screen-share/screen-share.service';
import { CoturnService } from '../coturn/coturn.service';
import { ChatService, ChatMessage } from '../chat/chat.service';
import { ReactionsService } from '../reactions/reactions.service';
import {
  RealtimeBroadcaster,
  meetingRoomName,
} from './realtime-broadcaster.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ServerEvent } from '../interfaces/socket-events.enum';
import { MeetingType } from '../interfaces/meeting-type.enum';
import { ParticipantRole } from '../interfaces/role.enum';
import { INSTANCE_CONFIG, InstanceAppConfig } from '../config/config.module';
import { WrongInstanceError } from './wrong-instance.error';

export interface WaitingResult {
  waiting: true;
}

export interface JoinedResult {
  waiting: false;
  rtpCapabilities: mediasoupTypes.RtpCapabilities;
  participants: ReturnType<Participant['toPublicJSON']>[];
  meetingState: ReturnType<Meeting['toStateJSON']>;
  iceServers: ReturnType<CoturnService['generateIceServers']>;
  self: ReturnType<Participant['toPublicJSON']>;
  /** Bounded recent history (CHAT_HISTORY_LIMIT) — empty for 1:1 calls, which have no chat. */
  chatHistory: ChatMessage[];
  /**
   * Producers that existed *before* this join — the `newProducer` broadcast
   * only fires for producers created after you're already in the room, so
   * without this a participant joining after someone's camera/mic is
   * already on would never see it. Same shape as the `newProducer` event so
   * clients can feed both through one consume() code path.
   */
  existingProducers: Array<{
    producerId: string;
    peerId: string;
    kind: mediasoupTypes.MediaKind;
    appData: Record<string, unknown>;
  }>;
}

/**
 * Core mediasoup signaling logic shared by CallsGateway (/calls, 1:1) and
 * MeetingsGateway (/meetings, group). Deliberately a plain injectable
 * service rather than a shared gateway base class: NestJS's gateway
 * decorator scanner only reliably picks up @SubscribeMessage handlers
 * declared directly on the concrete gateway class, so each gateway keeps
 * its own thin handler methods and delegates the real work here — avoids
 * duplicating mediasoup logic without relying on fragile decorator
 * inheritance.
 */
@Injectable()
export class SignalingService {
  private readonly logger = new Logger(SignalingService.name);
  readonly disconnectGraceMs: number;

  constructor(
    private readonly meetingService: MeetingService,
    private readonly participantService: ParticipantService,
    private readonly waitingRoomService: WaitingRoomService,
    private readonly meetingDirectory: MeetingDirectoryService,
    private readonly routerManager: RouterManagerService,
    private readonly transportService: TransportService,
    private readonly producerConsumer: ProducerConsumerService,
    private readonly screenShare: ScreenShareService,
    private readonly coturn: CoturnService,
    private readonly chatService: ChatService,
    private readonly reactionsService: ReactionsService,
    private readonly broadcaster: RealtimeBroadcaster,
    @Inject(INSTANCE_CONFIG) private readonly instanceConfig: InstanceAppConfig,
    config: ConfigService,
  ) {
    this.disconnectGraceMs = config.get<number>(
      'DISCONNECT_GRACE_PERIOD_MS',
      10000,
    );

    // Relays RouterManagerService's internal AudioLevelObserver events out to
    // clients. Without this listener, active-speaker detection computes but
    // never reaches anyone — the observer only ever emits on the internal bus.
    this.routerManager.on(
      'activeSpeaker',
      (event: { meetingId: string; peerId: string | null }) => {
        const meeting = this.meetingService.find(event.meetingId);
        if (!meeting || meeting.isEnded) return;
        this.broadcaster.emitToMeeting(
          meeting.namespace,
          meeting.id,
          ServerEvent.ACTIVE_SPEAKER_CHANGED,
          {
            peerId: event.peerId,
          },
        );
      },
    );
  }

  getMeetingForNamespace(meetingId: string, namespace: string): Meeting {
    const meeting = this.meetingService.getOrThrow(meetingId);
    if (meeting.namespace !== namespace) {
      throw new BadRequestException(
        `Meeting ${meetingId} does not belong to ${namespace}`,
      );
    }
    return meeting;
  }

  requireParticipant(meeting: Meeting, client: Socket): Participant {
    const userId = client.data.userId as string | undefined;
    if (!userId) throw new BadRequestException('Not joined to this meeting');
    const participant = this.participantService.findByUserId(meeting, userId);
    if (!participant || participant.socketId !== client.id) {
      throw new BadRequestException(
        'Not an active participant of this meeting',
      );
    }
    return participant;
  }

  /**
   * Defense-in-depth for sticky routing. The primary mechanism is that REST
   * create responses already carry `instanceUrl` (Meeting.toStateJSON) so a
   * well-behaved client opens its socket against the right instance from
   * the start — a raw WebRTC signaling session can't be transparently
   * forwarded to another process the way a REST call can. This check
   * catches the case where a socket lands here anyway (stale client cache,
   * a naive round-robin LB with no meeting-aware routing) and tells the
   * client where to actually go instead of silently operating against a
   * router this instance doesn't have.
   */
  private async assertOwnedByThisInstance(meetingId: string): Promise<void> {
    const owner = await this.meetingDirectory.getOwner(meetingId);
    if (!owner) {
      // No directory entry — either single-instance mode (no-op directory),
      // a meeting that doesn't exist anywhere (let getMeetingForNamespace,
      // called right after this, 404 it the normal way), or a lost/expired
      // entry for a meeting this instance genuinely does hold locally, in
      // which case claiming it here is a defensive fallback (not the normal
      // path — MeetingService.create already registers ownership at
      // creation). Checked via meetingService.find rather than
      // getMeetingForNamespace here since we don't want to throw yet.
      if (this.meetingService.find(meetingId)) {
        await this.meetingDirectory.registerOwnership(
          meetingId,
          this.instanceConfig,
        );
      }
      return;
    }
    if (owner.instanceId !== this.instanceConfig.instanceId) {
      throw new WrongInstanceError(owner.internalUrl);
    }
  }

  async joinRoom(
    client: Socket,
    meetingId: string,
    namespace: string,
  ): Promise<WaitingResult | JoinedResult> {
    // Ownership must be checked BEFORE any local-existence lookup — a
    // meeting owned by another instance was never created in *this*
    // instance's in-memory repository, so getMeetingForNamespace would
    // otherwise throw a plain "not found" instead of redirecting the client
    // to where the meeting actually lives.
    await this.assertOwnedByThisInstance(meetingId);
    const meeting = this.getMeetingForNamespace(meetingId, namespace);
    if (meeting.isEnded) throw new BadRequestException('Meeting has ended');

    const user = client.data.user as AuthenticatedUser;

    const existing = this.participantService.findByUserId(meeting, user.id);
    if (existing) {
      // Reconnect: cancel any pending grace-period cleanup and rebind the socket.
      if (existing.pendingLeaveTimer) {
        clearTimeout(existing.pendingLeaveTimer);
        existing.pendingLeaveTimer = undefined;
      }
      // The old socket's transports/producers/consumers belong to a peer
      // connection the browser already discarded (see the client's
      // resetTransportState, called right after it reconnects) — left open
      // here they leak mediasoup transports/producers forever and leave
      // every other participant's consumer pointed at a producer whose RTP
      // stopped the moment the tab dropped, showing a frozen last frame
      // until this peer happens to re-toggle their camera/mic.
      // closeAllMedia()'s transport.close() cascades to producer.close(),
      // which mediasoup itself propagates to each remote consumer's
      // 'producerclose' event, so the existing consume() handler notifies
      // those peers correctly and clears the stale tile.
      if (existing.presenting) this.screenShare.onStopped(meeting, existing);
      existing.closeAllMedia();
      existing.audioMuted = true;
      existing.videoEnabled = false;
      existing.socketId = client.id;
      client.data.meetingId = meetingId;
      client.data.userId = user.id;
      client.join(meetingRoomName(meetingId));
      const router = await this.meetingService.getOrCreateRouter(meeting);
      return this.buildJoinedResult(meeting, existing, router);
    }

    const role = this.participantService.resolveRole(meeting, user.id);

    if (meeting.waitingRoomEnabled && role !== ParticipantRole.HOST) {
      // Stamped so handleDisconnect (below) can find and evict this entry if
      // the visitor closes the tab before a host admits/rejects them —
      // without meetingId/userId on the socket, a disconnect while waiting
      // was previously invisible to the gateway's handleDisconnect (it
      // bails out on `if (!meetingId) return`), leaving a "waiting to join"
      // entry that no host could ever clear pointing at a dead socket.
      client.data.meetingId = meetingId;
      client.data.userId = user.id;
      this.waitingRoomService.add(meeting, {
        userId: user.id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        socketId: client.id,
        requestedAt: new Date(),
      });
      return { waiting: true };
    }

    if (meeting.locked && role !== ParticipantRole.HOST) {
      throw new BadRequestException('Meeting is locked');
    }

    const participant = new Participant({
      userId: user.id,
      socketId: client.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role,
      meetingId,
    });
    this.participantService.addParticipant(meeting, participant);

    client.data.meetingId = meetingId;
    client.data.userId = user.id;
    client.join(meetingRoomName(meetingId));

    const router = await this.meetingService.getOrCreateRouter(meeting);

    this.broadcaster.emitToMeetingExcept(
      meeting.namespace,
      meeting.id,
      client.id,
      ServerEvent.USER_JOINED,
      participant.toPublicJSON(),
    );

    return this.buildJoinedResult(meeting, participant, router);
  }

  private buildJoinedResult(
    meeting: Meeting,
    self: Participant,
    router: mediasoupTypes.Router,
  ): JoinedResult {
    return {
      waiting: false,
      rtpCapabilities: router.rtpCapabilities,
      participants: this.participantService
        .list(meeting)
        .filter((p) => p.userId !== self.userId)
        .map((p) => p.toPublicJSON()),
      meetingState: meeting.toStateJSON(),
      iceServers: this.coturn.generateIceServers(self.userId),
      self: self.toPublicJSON(),
      chatHistory: this.chatService.getHistory(meeting.id),
      existingProducers: this.listExistingProducers(meeting, self.userId),
    };
  }

  private listExistingProducers(
    meeting: Meeting,
    excludeUserId: string,
  ): JoinedResult['existingProducers'] {
    const result: JoinedResult['existingProducers'] = [];
    for (const participant of meeting.participants.values()) {
      if (participant.userId === excludeUserId) continue;
      for (const producer of participant.producers.values()) {
        result.push({
          producerId: producer.id,
          peerId: participant.userId,
          kind: producer.kind,
          appData: producer.appData as Record<string, unknown>,
        });
      }
    }
    return result;
  }

  leaveRoom(client: Socket, meeting: Meeting): void {
    const participant = this.requireParticipant(meeting, client);
    client.leave(meetingRoomName(meeting.id));
    this.finalizeLeave(meeting, participant.userId);
  }

  /**
   * Single entry point both gateways' handleDisconnect should call. A
   * dropped socket is either a seated participant (gets the reconnect grace
   * period below) or someone still parked in the waiting room — the latter
   * has no media/grace semantics to preserve, so it's evicted immediately
   * rather than sitting in `meeting.waitingParticipants` forever pointing at
   * a socket that will never come back.
   */
  handleDisconnect(client: Socket, meeting: Meeting): void {
    const userId = client.data.userId as string | undefined;
    if (!userId) return;
    if (meeting.waitingParticipants.get(userId)?.socketId === client.id) {
      meeting.waitingParticipants.delete(userId);
      return;
    }
    this.scheduleDisconnectCleanup(client, meeting);
  }

  /** Gives brief reconnect tolerance before tearing down media. */
  private scheduleDisconnectCleanup(client: Socket, meeting: Meeting): void {
    const userId = client.data.userId as string | undefined;
    if (!userId) return;
    const participant = this.participantService.findByUserId(meeting, userId);
    if (!participant || participant.socketId !== client.id) return;

    participant.pendingLeaveTimer = setTimeout(() => {
      this.finalizeLeave(meeting, userId);
    }, this.disconnectGraceMs);
  }

  private finalizeLeave(meeting: Meeting, userId: string): void {
    const participant = this.participantService.findByUserId(meeting, userId);
    if (!participant) return;

    if (participant.presenting)
      this.screenShare.onStopped(meeting, participant);

    // Otherwise this user's burst-throttle entry in ReactionsService.recent
    // is never removed — it only shrinks to an empty array, staying resident
    // for the life of the process (one leaked Map entry per distinct user
    // who has ever sent a reaction in any meeting).
    this.reactionsService.clearUser(userId);

    this.participantService.removeParticipant(meeting, userId);
    this.broadcaster.emitToMeeting(
      meeting.namespace,
      meeting.id,
      ServerEvent.USER_LEFT,
      { peerId: userId },
    );

    if (meeting.type === MeetingType.ONE_TO_ONE) {
      if (!meeting.isEnded)
        this.meetingService.end(meeting.id, `${userId} left the call`);
      return;
    }

    if (meeting.participantCount === 0 && !meeting.isEnded) {
      this.routerManager.closeRouter(meeting.id);
    }
  }

  async createTransport(
    client: Socket,
    meeting: Meeting,
    direction: TransportDirection,
  ): Promise<{ params: ReturnType<TransportService['toParams']> }> {
    const participant = this.requireParticipant(meeting, client);
    const router = this.routerManager.getRouter(meeting.id);
    const webRtcServer = this.routerManager.getWebRtcServer(meeting.id);
    if (!router || !webRtcServer)
      throw new NotFoundException('Router not ready for this meeting');

    const transport = await this.transportService.createWebRtcTransport(
      router,
      webRtcServer,
      {
        peerId: participant.userId,
        direction,
      },
    );
    participant.addTransport(transport);
    // The frontend's mediasoup-client wrapper destructures `{ params }` off
    // the ack (see PeerConnection.ts's createTransport/consume) — a
    // convention carried over from the original nVerify protocol, which
    // always wrapped transport/consumer params this way.
    return { params: this.transportService.toParams(transport) };
  }

  async connectTransport(
    client: Socket,
    meeting: Meeting,
    transportId: string,
    dtlsParameters: mediasoupTypes.DtlsParameters,
  ): Promise<{ connected: true }> {
    const participant = this.requireParticipant(meeting, client);
    const transport = participant.transports.get(transportId);
    if (!transport) throw new NotFoundException('Transport not found');
    await this.transportService.connect(transport, dtlsParameters);
    return { connected: true };
  }

  async produce(
    client: Socket,
    meeting: Meeting,
    transportId: string,
    kind: mediasoupTypes.MediaKind,
    rtpParameters: mediasoupTypes.RtpParameters,
    clientAppData: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const participant = this.requireParticipant(meeting, client);
    const transport = participant.transports.get(transportId);
    if (!transport) throw new NotFoundException('Transport not found');

    // peerId is always server-stamped — never trust the client's own claim of identity here.
    const appData: Record<string, unknown> = {
      ...clientAppData,
      peerId: participant.userId,
    };
    const isScreen = appData.source === 'screen';
    if (isScreen) this.screenShare.assertCanStart(meeting, participant.userId);

    const producer = await this.producerConsumer.produce(transport, {
      kind,
      rtpParameters,
      appData,
    });
    participant.addProducer(producer);

    producer.on('transportclose', () =>
      participant.producers.delete(producer.id),
    );

    if (kind === 'audio') {
      await this.routerManager.addProducerToAudioLevelObserver(
        meeting.id,
        producer,
      );
      participant.audioMuted = false;
      this.broadcaster.emitToMeeting(
        meeting.namespace,
        meeting.id,
        ServerEvent.AUDIO_UNMUTED,
        {
          peerId: participant.userId,
        },
      );
    } else if (isScreen) {
      this.screenShare.onStarted(meeting, participant);
    } else {
      participant.videoEnabled = true;
      this.broadcaster.emitToMeeting(
        meeting.namespace,
        meeting.id,
        ServerEvent.VIDEO_ENABLED,
        {
          peerId: participant.userId,
        },
      );
    }

    this.broadcaster.emitToMeetingExcept(
      meeting.namespace,
      meeting.id,
      client.id,
      ServerEvent.NEW_PRODUCER,
      { producerId: producer.id, peerId: participant.userId, kind, appData },
    );

    return { id: producer.id };
  }

  async consume(
    client: Socket,
    meeting: Meeting,
    transportId: string,
    producerId: string,
    rtpCapabilities: mediasoupTypes.RtpCapabilities,
  ) {
    const participant = this.requireParticipant(meeting, client);
    const transport = participant.transports.get(transportId);
    if (!transport) throw new NotFoundException('Transport not found');

    const router = this.routerManager.getRouter(meeting.id);
    if (!router)
      throw new NotFoundException('Router not ready for this meeting');

    const producer = this.findProducer(meeting, producerId);
    if (!producer) throw new NotFoundException('Producer not found');

    const { consumer, params } = await this.producerConsumer.consume(
      router,
      transport,
      producer,
      rtpCapabilities,
      { peerId: participant.userId },
    );
    participant.addConsumer(consumer);

    consumer.on('producerclose', () => {
      participant.consumers.delete(consumer.id);
      this.broadcaster.emitToSocket(
        meeting.namespace,
        client.id,
        ServerEvent.PRODUCER_CLOSED,
        {
          producerId,
        },
      );
    });

    // Same `{ params }` wrapper as createTransport above — the client
    // destructures `response.params` off this ack.
    return { params };
  }

  private findProducer(
    meeting: Meeting,
    producerId: string,
  ): mediasoupTypes.Producer | undefined {
    for (const p of meeting.participants.values()) {
      const producer = p.findProducer(producerId);
      if (producer) return producer;
    }
    return undefined;
  }

  async resumeConsumer(
    client: Socket,
    meeting: Meeting,
    consumerId: string,
  ): Promise<{ resumed: true }> {
    const participant = this.requireParticipant(meeting, client);
    const consumer = participant.consumers.get(consumerId);
    if (!consumer) throw new NotFoundException('Consumer not found');
    await this.producerConsumer.resumeConsumer(consumer);
    return { resumed: true };
  }

  async setPreferredLayers(
    client: Socket,
    meeting: Meeting,
    consumerId: string,
    spatialLayer: number,
    temporalLayer?: number,
  ): Promise<{ ok: true }> {
    const participant = this.requireParticipant(meeting, client);
    const consumer = participant.consumers.get(consumerId);
    if (!consumer) throw new NotFoundException('Consumer not found');
    await this.producerConsumer.setPreferredLayers(
      consumer,
      spatialLayer,
      temporalLayer,
    );
    return { ok: true };
  }

  async pauseProducer(
    client: Socket,
    meeting: Meeting,
    producerId: string,
  ): Promise<{ paused: true }> {
    const participant = this.requireParticipant(meeting, client);
    const producer = participant.producers.get(producerId);
    if (!producer) throw new NotFoundException('Producer not found');
    await this.producerConsumer.pauseProducer(producer);
    this.applyProducerStateChange(meeting, participant, producer, true);
    return { paused: true };
  }

  async resumeProducer(
    client: Socket,
    meeting: Meeting,
    producerId: string,
  ): Promise<{ resumed: true }> {
    const participant = this.requireParticipant(meeting, client);
    const producer = participant.producers.get(producerId);
    if (!producer) throw new NotFoundException('Producer not found');
    await this.producerConsumer.resumeProducer(producer);
    this.applyProducerStateChange(meeting, participant, producer, false);
    return { resumed: true };
  }

  closeProducer(
    client: Socket,
    meeting: Meeting,
    producerId: string,
  ): { closed: true } {
    const participant = this.requireParticipant(meeting, client);
    const producer = participant.producers.get(producerId);
    if (!producer) throw new NotFoundException('Producer not found');

    const wasScreen = isScreenShareProducer(producer);
    this.producerConsumer.closeProducer(producer);
    participant.producers.delete(producerId);

    if (wasScreen) {
      this.screenShare.onStopped(meeting, participant);
    } else if (producer.kind === 'video') {
      participant.videoEnabled = false;
      this.broadcaster.emitToMeeting(
        meeting.namespace,
        meeting.id,
        ServerEvent.VIDEO_DISABLED,
        {
          peerId: participant.userId,
        },
      );
    } else {
      participant.audioMuted = true;
      this.broadcaster.emitToMeeting(
        meeting.namespace,
        meeting.id,
        ServerEvent.AUDIO_MUTED,
        {
          peerId: participant.userId,
          forced: false,
        },
      );
    }

    this.broadcaster.emitToMeeting(
      meeting.namespace,
      meeting.id,
      ServerEvent.PRODUCER_CLOSED,
      {
        producerId,
        peerId: participant.userId,
      },
    );
    return { closed: true };
  }

  private applyProducerStateChange(
    meeting: Meeting,
    participant: Participant,
    producer: mediasoupTypes.Producer,
    paused: boolean,
  ): void {
    if (producer.kind === 'audio') {
      participant.audioMuted = paused;
      this.broadcaster.emitToMeeting(
        meeting.namespace,
        meeting.id,
        paused ? ServerEvent.AUDIO_MUTED : ServerEvent.AUDIO_UNMUTED,
        { peerId: participant.userId, forced: false },
      );
    } else if (!isScreenShareProducer(producer)) {
      participant.videoEnabled = !paused;
      this.broadcaster.emitToMeeting(
        meeting.namespace,
        meeting.id,
        paused ? ServerEvent.VIDEO_DISABLED : ServerEvent.VIDEO_ENABLED,
        { peerId: participant.userId },
      );
    }
  }

  async restartIce(
    client: Socket,
    meeting: Meeting,
    transportId: string,
  ): Promise<mediasoupTypes.IceParameters> {
    const participant = this.requireParticipant(meeting, client);
    const transport = participant.transports.get(transportId);
    if (!transport) throw new NotFoundException('Transport not found');
    return this.transportService.restartIce(transport);
  }

  startScreenShare(client: Socket, meeting: Meeting): { allowed: true } {
    const participant = this.requireParticipant(meeting, client);
    this.screenShare.assertCanStart(meeting, participant.userId);
    meeting.activePresenterId = participant.userId;
    return { allowed: true };
  }

  stopScreenShare(client: Socket, meeting: Meeting): { stopped: true } {
    const participant = this.requireParticipant(meeting, client);
    for (const producer of participant.producers.values()) {
      if (isScreenShareProducer(producer)) {
        this.producerConsumer.closeProducer(producer);
        participant.producers.delete(producer.id);
      }
    }
    this.screenShare.onStopped(meeting, participant);
    return { stopped: true };
  }
}
