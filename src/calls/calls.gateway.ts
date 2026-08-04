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
import { SignalingService } from '../websocket/signaling.service';
import { ConnectionGuardService } from '../websocket/connection-guard.service';
import { RealtimeBroadcaster } from '../websocket/realtime-broadcaster.service';
import { MeetingService } from '../meeting/meeting.service';
import { TransportDirection } from '../mediasoup/types';
import { validateWsPayload } from '../utils/ws-validate.util';
import { respond } from '../websocket/ws-response.util';
import { ClientEvent, ServerEvent } from '../interfaces/socket-events.enum';
import {
  ConnectTransportDto,
  ConsumeDto,
  CreateTransportDto,
  JoinRoomDto,
  LeaveRoomDto,
  MeetingIdOnlyDto,
  ProduceDto,
  ProducerIdDto,
  ConsumerIdDto,
  TransportIdDto,
} from '../websocket/dto/signaling.dto';

const NAMESPACE = '/calls';

/**
 * Lightweight 1:1 audio/video call signaling — join/leave, transports,
 * produce/consume, mute/camera toggle (via pause/resumeProducer), screen
 * share, ICE restart. No host hierarchy, moderation, chat, or waiting room —
 * see MeetingsGateway (/meetings) for group calls and large standups.
 */
@WebSocketGateway({
  namespace: NAMESPACE,
  cors: { origin: process.env.CORS_ORIGIN ?? '*', credentials: true },
  transports: ['polling', 'websocket'],
})
export class CallsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Namespace;

  private readonly logger = new Logger(CallsGateway.name);

  constructor(
    private readonly signaling: SignalingService,
    private readonly guard: ConnectionGuardService,
    private readonly broadcaster: RealtimeBroadcaster,
    private readonly meetingService: MeetingService,
  ) {}

  afterInit(server: Namespace): void {
    this.broadcaster.registerNamespace(NAMESPACE, server);
    this.logger.log(`${NAMESPACE} namespace initialized`);
  }

  handleConnection(client: Socket): void {
    try {
      client.data.user = this.guard.authenticate(client);
    } catch (err) {
      client.emit(ServerEvent.ERROR, {
        message: err instanceof Error ? err.message : 'Unauthorized',
      });
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
      const meeting = this.signaling.getMeetingForNamespace(dto.meetingId, NAMESPACE);
      this.signaling.leaveRoom(client, meeting);
      return { left: true };
    });
  }

  @SubscribeMessage(ClientEvent.CREATE_TRANSPORT)
  onCreateTransport(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      this.assertRate(client);
      const dto = validateWsPayload(CreateTransportDto, body);
      const meeting = this.signaling.getMeetingForNamespace(dto.meetingId, NAMESPACE);
      const direction = dto.direction === 'send' ? TransportDirection.SEND : TransportDirection.RECV;
      return this.signaling.createTransport(client, meeting, direction);
    });
  }

  @SubscribeMessage(ClientEvent.CONNECT_TRANSPORT)
  onConnectTransport(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(ConnectTransportDto, body);
      const meeting = this.signaling.getMeetingForNamespace(dto.meetingId, NAMESPACE);
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
      const meeting = this.signaling.getMeetingForNamespace(dto.meetingId, NAMESPACE);
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
      const meeting = this.signaling.getMeetingForNamespace(dto.meetingId, NAMESPACE);
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
  onResumeConsumer(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(ConsumerIdDto, body);
      const meeting = this.signaling.getMeetingForNamespace(dto.meetingId, NAMESPACE);
      return this.signaling.resumeConsumer(client, meeting, dto.consumerId);
    });
  }

  @SubscribeMessage(ClientEvent.PAUSE_PRODUCER)
  onPauseProducer(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(ProducerIdDto, body);
      const meeting = this.signaling.getMeetingForNamespace(dto.meetingId, NAMESPACE);
      return this.signaling.pauseProducer(client, meeting, dto.producerId);
    });
  }

  @SubscribeMessage(ClientEvent.RESUME_PRODUCER)
  onResumeProducer(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(ProducerIdDto, body);
      const meeting = this.signaling.getMeetingForNamespace(dto.meetingId, NAMESPACE);
      return this.signaling.resumeProducer(client, meeting, dto.producerId);
    });
  }

  @SubscribeMessage(ClientEvent.CLOSE_PRODUCER)
  onCloseProducer(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(ProducerIdDto, body);
      const meeting = this.signaling.getMeetingForNamespace(dto.meetingId, NAMESPACE);
      return this.signaling.closeProducer(client, meeting, dto.producerId);
    });
  }

  @SubscribeMessage(ClientEvent.RESTART_ICE)
  onRestartIce(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(TransportIdDto, body);
      const meeting = this.signaling.getMeetingForNamespace(dto.meetingId, NAMESPACE);
      return this.signaling.restartIce(client, meeting, dto.transportId);
    });
  }

  @SubscribeMessage(ClientEvent.START_SCREEN_SHARE)
  onStartScreenShare(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(MeetingIdOnlyDto, body);
      const meeting = this.signaling.getMeetingForNamespace(dto.meetingId, NAMESPACE);
      return this.signaling.startScreenShare(client, meeting);
    });
  }

  @SubscribeMessage(ClientEvent.STOP_SCREEN_SHARE)
  onStopScreenShare(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(MeetingIdOnlyDto, body);
      const meeting = this.signaling.getMeetingForNamespace(dto.meetingId, NAMESPACE);
      return this.signaling.stopScreenShare(client, meeting);
    });
  }

  @SubscribeMessage(ClientEvent.END_MEETING)
  onEndCall(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return respond(() => {
      const dto = validateWsPayload(MeetingIdOnlyDto, body);
      // Either party can end a 1:1 call — no host hierarchy for two people.
      this.signaling.getMeetingForNamespace(dto.meetingId, NAMESPACE);
      this.meetingService.end(dto.meetingId, `Ended by ${(client.data.user?.id as string) ?? 'participant'}`);
      return { ended: true };
    });
  }

  @SubscribeMessage(ClientEvent.HEARTBEAT)
  onHeartbeat(@ConnectedSocket() client: Socket) {
    client.emit(ServerEvent.HEARTBEAT_ACK, { at: Date.now() });
  }

  private assertRate(client: Socket): void {
    if (!this.guard.checkEventRate(client)) {
      throw new Error('Rate limit exceeded');
    }
  }
}
