import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { SignalingService } from './signaling.service';
import { ConnectionGuardService } from './connection-guard.service';
import { RealtimeBroadcaster } from './realtime-broadcaster.service';
import { MeetingService } from '../meeting/meeting.service';
import { WaitingRoomService } from '../meeting/waiting-room.service';
import { ParticipantService } from '../participant/participant.service';
import { ChatService } from '../chat/chat.service';
import { ReactionsService } from '../reactions/reactions.service';
import { ModerationService } from '../moderation/moderation.service';
import { TransportDirection } from '../mediasoup/types';
import { validateWsPayload } from '../utils/ws-validate.util';
import { respond } from './ws-response.util';
import { ClientEvent, ServerEvent } from '../interfaces/socket-events.enum';
import { ParticipantRole } from '../interfaces/role.enum';
import {
  ChatMessageDto,
  ConnectTransportDto,
  ConsumeDto,
  ConsumerIdDto,
  CreateTransportDto,
  JoinRoomDto,
  LeaveRoomDto,
  MeetingIdOnlyDto,
  ProduceDto,
  ProducerIdDto,
  ReactionDto,
  SetFeatureDto,
  SetPreferredLayersDto,
  TargetPeerDto,
  TransportIdDto,
} from './dto/signaling.dto';

const NAMESPACE = '/meetings';

/**
 * Full-featured group call / large standup meeting signaling: everything
 * CallsGateway has, plus chat, reactions, raise hand, host controls,
 * moderator promotion, and the waiting room. See CallsGateway (/calls) for
 * the simpler 1:1 counterpart.
 */
@WebSocketGateway({
  namespace: NAMESPACE,
  cors: { origin: process.env.CORS_ORIGIN ?? '*', credentials: true },
  transports: ['polling', 'websocket'],
})
export class MeetingsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Namespace;

  private readonly logger = new Logger(MeetingsGateway.name);

  constructor(
    private readonly signaling: SignalingService,
    private readonly guard: ConnectionGuardService,
    private readonly broadcaster: RealtimeBroadcaster,
    private readonly meetingService: MeetingService,
    private readonly waitingRoom: WaitingRoomService,
    private readonly participants: ParticipantService,
    private readonly chat: ChatService,
    private readonly reactions: ReactionsService,
    private readonly moderation: ModerationService,
  ) {}

  afterInit(server: Namespace): void {
    this.broadcaster.registerNamespace(NAMESPACE, server);
    this.logger.log(`${NAMESPACE} namespace initialized`);
  }

  handleConnection(client: Socket): void {
    try {
      client.data.user = this.guard.authenticate(client);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unauthorized';
      this.logger.warn(
        `Rejected /meetings connection ${client.id} from ${client.handshake.address}: ${message}`,
      );
      client.emit(ServerEvent.ERROR, { message });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.guard.releaseConnection(client);
    const meetingId = client.data.meetingId as string | undefined;
    if (!meetingId) return;
    const meeting = this.meetingService.find(meetingId);
    if (!meeting || meeting.isEnded) return;
    this.signaling.handleDisconnect(client, meeting);
  }

  // ---- Core signaling (shared shape with CallsGateway) ----------------

  @SubscribeMessage(ClientEvent.JOIN_ROOM)
  onJoinRoom(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      this.assertRate(client);
      const dto = validateWsPayload(JoinRoomDto, body);
      return this.signaling.joinRoom(client, dto.meetingId, NAMESPACE);
    });
  }

  @SubscribeMessage(ClientEvent.LEAVE_ROOM)
  onLeaveRoom(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(LeaveRoomDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      this.signaling.leaveRoom(client, meeting);
      return { left: true };
    });
  }

  @SubscribeMessage(ClientEvent.CREATE_TRANSPORT)
  onCreateTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      this.assertRate(client);
      const dto = validateWsPayload(CreateTransportDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const direction =
        dto.direction === 'send'
          ? TransportDirection.SEND
          : TransportDirection.RECV;
      return this.signaling.createTransport(client, meeting, direction);
    });
  }

  @SubscribeMessage(ClientEvent.CONNECT_TRANSPORT)
  onConnectTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      const dto = validateWsPayload(ConnectTransportDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      return this.signaling.connectTransport(
        client,
        meeting,
        dto.transportId,
        dto.dtlsParameters as never,
      );
    });
  }

  @SubscribeMessage(ClientEvent.PRODUCE)
  onProduce(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      this.assertRate(client);
      const dto = validateWsPayload(ProduceDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      return this.signaling.produce(
        client,
        meeting,
        dto.transportId,
        dto.kind,
        dto.rtpParameters as never,
        dto.appData,
      );
    });
  }

  @SubscribeMessage(ClientEvent.CONSUME)
  onConsume(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      this.assertRate(client);
      const dto = validateWsPayload(ConsumeDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      return this.signaling.consume(
        client,
        meeting,
        dto.transportId,
        dto.producerId,
        dto.rtpCapabilities as never,
      );
    });
  }

  @SubscribeMessage(ClientEvent.RESUME_CONSUMER)
  onResumeConsumer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      const dto = validateWsPayload(ConsumerIdDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      return this.signaling.resumeConsumer(client, meeting, dto.consumerId);
    });
  }

  @SubscribeMessage(ClientEvent.SET_PREFERRED_LAYERS)
  onSetPreferredLayers(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(SetPreferredLayersDto, body);
      const meeting = this.signaling.getMeetingForNamespace(dto.meetingId, NAMESPACE);
      return this.signaling.setPreferredLayers(
        client,
        meeting,
        dto.consumerId,
        dto.spatialLayer,
        dto.temporalLayer,
      );
    });
  }

  @SubscribeMessage(ClientEvent.PAUSE_PRODUCER)
  onPauseProducer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      const dto = validateWsPayload(ProducerIdDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      return this.signaling.pauseProducer(client, meeting, dto.producerId);
    });
  }

  @SubscribeMessage(ClientEvent.RESUME_PRODUCER)
  onResumeProducer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      const dto = validateWsPayload(ProducerIdDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      return this.signaling.resumeProducer(client, meeting, dto.producerId);
    });
  }

  @SubscribeMessage(ClientEvent.CLOSE_PRODUCER)
  onCloseProducer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      const dto = validateWsPayload(ProducerIdDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      return this.signaling.closeProducer(client, meeting, dto.producerId);
    });
  }

  @SubscribeMessage(ClientEvent.RESTART_ICE)
  onRestartIce(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      const dto = validateWsPayload(TransportIdDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      return this.signaling.restartIce(client, meeting, dto.transportId);
    });
  }

  @SubscribeMessage(ClientEvent.START_SCREEN_SHARE)
  onStartScreenShare(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      const dto = validateWsPayload(MeetingIdOnlyDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      return this.signaling.startScreenShare(client, meeting);
    });
  }

  @SubscribeMessage(ClientEvent.STOP_SCREEN_SHARE)
  onStopScreenShare(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      const dto = validateWsPayload(MeetingIdOnlyDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      return this.signaling.stopScreenShare(client, meeting);
    });
  }

  @SubscribeMessage(ClientEvent.HEARTBEAT)
  onHeartbeat(@ConnectedSocket() client: Socket) {
    client.emit(ServerEvent.HEARTBEAT_ACK, { at: Date.now() });
  }

  // ---- Group-meeting-only features -------------------------------------

  @SubscribeMessage(ClientEvent.RAISE_HAND)
  onRaiseHand(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(MeetingIdOnlyDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const participant = this.signaling.requireParticipant(meeting, client);
      participant.handRaised = true;
      this.broadcaster.emitToMeeting(
        NAMESPACE,
        meeting.id,
        ServerEvent.HAND_RAISED,
        {
          peerId: participant.userId,
        },
      );
      return { raised: true };
    });
  }

  @SubscribeMessage(ClientEvent.LOWER_HAND)
  onLowerHand(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(MeetingIdOnlyDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const participant = this.signaling.requireParticipant(meeting, client);
      participant.handRaised = false;
      this.broadcaster.emitToMeeting(
        NAMESPACE,
        meeting.id,
        ServerEvent.HAND_LOWERED,
        {
          peerId: participant.userId,
        },
      );
      return { lowered: true };
    });
  }

  /** Host/moderator lowering someone else's hand — distinct from onLowerHand (self only). */
  @SubscribeMessage(ClientEvent.LOWER_PARTICIPANT_HAND)
  onLowerParticipantHand(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      const dto = validateWsPayload(TargetPeerDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const actor = this.signaling.requireParticipant(meeting, client);
      this.moderation.lowerHand(
        meeting,
        { role: actor.role, userId: actor.userId },
        dto.targetUserId,
      );
      return { lowered: dto.targetUserId };
    });
  }

  @SubscribeMessage(ClientEvent.INVITE_TO_SPEAK)
  onInviteToSpeak(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      const dto = validateWsPayload(TargetPeerDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const actor = this.signaling.requireParticipant(meeting, client);
      this.moderation.inviteToSpeak(
        meeting,
        { role: actor.role, userId: actor.userId },
        dto.targetUserId,
      );
      return { invited: dto.targetUserId };
    });
  }

  @SubscribeMessage(ClientEvent.REACTION)
  onReaction(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(ReactionDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const participant = this.signaling.requireParticipant(meeting, client);
      this.reactions.validate(meeting, participant.userId, dto.emoji);
      this.broadcaster.emitToMeeting(
        NAMESPACE,
        meeting.id,
        ServerEvent.REACTION,
        {
          peerId: participant.userId,
          emoji: dto.emoji,
          at: Date.now(),
        },
      );
      return { sent: true };
    });
  }

  @SubscribeMessage(ClientEvent.CHAT_MESSAGE)
  onChatMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      const dto = validateWsPayload(ChatMessageDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const participant = this.signaling.requireParticipant(meeting, client);
      const message = this.chat.addMessage(
        meeting,
        participant.userId,
        participant.displayName,
        dto.text,
      );
      this.broadcaster.emitToMeeting(
        NAMESPACE,
        meeting.id,
        ServerEvent.CHAT_MESSAGE,
        message,
      );
      return message;
    });
  }

  @SubscribeMessage(ClientEvent.MUTE)
  onMute(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(async () => {
      const dto = validateWsPayload(TargetPeerDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const actor = this.signaling.requireParticipant(meeting, client);
      await this.moderation.muteParticipant(
        meeting,
        { role: actor.role, userId: actor.userId },
        dto.targetUserId,
      );
      return { muted: dto.targetUserId };
    });
  }

  @SubscribeMessage(ClientEvent.REQUEST_UNMUTE)
  onRequestUnmute(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      const dto = validateWsPayload(TargetPeerDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const actor = this.signaling.requireParticipant(meeting, client);
      this.moderation.requestUnmute(
        meeting,
        { role: actor.role, userId: actor.userId },
        dto.targetUserId,
      );
      return { requested: dto.targetUserId };
    });
  }

  @SubscribeMessage(ClientEvent.KICK)
  onKick(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(TargetPeerDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const actor = this.signaling.requireParticipant(meeting, client);
      this.moderation.removeParticipant(
        meeting,
        { role: actor.role, userId: actor.userId },
        dto.targetUserId,
      );
      return { removed: dto.targetUserId };
    });
  }

  @SubscribeMessage(ClientEvent.PROMOTE_MODERATOR)
  onPromote(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(TargetPeerDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const actor = this.signaling.requireParticipant(meeting, client);
      this.moderation.promote(
        meeting,
        { role: actor.role, userId: actor.userId },
        dto.targetUserId,
      );
      return { promoted: dto.targetUserId };
    });
  }

  @SubscribeMessage(ClientEvent.DEMOTE_MODERATOR)
  onDemote(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(TargetPeerDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const actor = this.signaling.requireParticipant(meeting, client);
      this.moderation.demote(
        meeting,
        { role: actor.role, userId: actor.userId },
        dto.targetUserId,
      );
      return { demoted: dto.targetUserId };
    });
  }

  @SubscribeMessage(ClientEvent.LOCK_MEETING)
  onLock(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(MeetingIdOnlyDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const actor = this.signaling.requireParticipant(meeting, client);
      this.moderation.setLocked(
        meeting,
        { role: actor.role, userId: actor.userId },
        true,
      );
      return { locked: true };
    });
  }

  @SubscribeMessage(ClientEvent.UNLOCK_MEETING)
  onUnlock(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(MeetingIdOnlyDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const actor = this.signaling.requireParticipant(meeting, client);
      this.moderation.setLocked(
        meeting,
        { role: actor.role, userId: actor.userId },
        false,
      );
      return { locked: false };
    });
  }

  @SubscribeMessage(ClientEvent.END_MEETING)
  onEndMeeting(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      const dto = validateWsPayload(MeetingIdOnlyDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const actor = this.signaling.requireParticipant(meeting, client);
      if (actor.role !== ParticipantRole.HOST)
        throw new Error('Only the host can end the meeting');
      this.meetingService.end(meeting.id, `Ended by host ${actor.userId}`);
      return { ended: true };
    });
  }

  @SubscribeMessage('disableFeature')
  onDisableFeature(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return respond(() => {
      const dto = validateWsPayload(SetFeatureDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const actor = this.signaling.requireParticipant(meeting, client);
      this.moderation.setFeatureEnabled(
        meeting,
        { role: actor.role, userId: actor.userId },
        dto.feature,
        dto.enabled,
      );
      return { feature: dto.feature, enabled: dto.enabled };
    });
  }

  @SubscribeMessage(ClientEvent.ADMIT_WAITING_PARTICIPANT)
  onAdmit(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(TargetPeerDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const actor = this.signaling.requireParticipant(meeting, client);
      const entry = this.waitingRoom.admit(
        meeting,
        actor.role,
        dto.targetUserId,
      );

      const admittedSocket = this.server.sockets.get(entry.socketId);
      if (admittedSocket) {
        this.signaling
          .joinRoom(admittedSocket, meeting.id, NAMESPACE)
          .then((result) => admittedSocket.emit(ServerEvent.ADMITTED, result))
          .catch((err: Error) =>
            admittedSocket.emit(ServerEvent.ERROR, {
              message: err.message ?? 'Failed to join after admission',
            }),
          );
      }
      return { admitted: dto.targetUserId };
    });
  }

  @SubscribeMessage(ClientEvent.REJECT_WAITING_PARTICIPANT)
  onReject(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(TargetPeerDto, body);
      const meeting = this.signaling.getMeetingForNamespace(
        dto.meetingId,
        NAMESPACE,
      );
      const actor = this.signaling.requireParticipant(meeting, client);
      this.waitingRoom.reject(meeting, actor.role, dto.targetUserId);
      return { rejected: dto.targetUserId };
    });
  }

  private assertRate(client: Socket): void {
    if (!this.guard.checkEventRate(client)) {
      throw new Error('Rate limit exceeded');
    }
  }
}
