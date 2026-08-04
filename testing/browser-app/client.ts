// Runs INSIDE a real (headless) Chromium page under Playwright. Bundled by
// build-browser-app.mjs into browser-app/dist/client.js. This is the one
// place in the whole testing/ project that does real WebRTC — everything in
// scenarios/*.spec.ts drives this class via page.evaluate(), so assertions
// about "ICE connected" / "audio flows" reflect genuine mediasoup-client
// Transport/Consumer state, not a simulation.
import { io, Socket } from 'socket.io-client';
import { Device } from 'mediasoup-client';
import type { Transport, Producer, Consumer } from 'mediasoup-client/types';

export interface Ack<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface CapturedEvent {
  event: string;
  payload: unknown;
  at: number;
}

function emitAck<T>(socket: Socket, event: string, payload: unknown, timeoutMs = 15000): Promise<Ack<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), timeoutMs);
    socket.emit(event, payload, (ack: Ack<T>) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

const BROADCAST_EVENTS = [
  'userJoined', 'userLeft', 'newProducer', 'producerClosed', 'videoEnabled', 'videoDisabled',
  'audioMuted', 'audioUnmuted', 'unmuteRequested', 'handRaised', 'handLowered', 'reaction',
  'chatMessage', 'screenShareStarted', 'screenShareStopped', 'participantRemoved',
  'participantRoleChanged', 'meetingLocked', 'meetingUnlocked', 'meetingEnded',
  'meetingStateUpdated', 'waitingRoomJoined', 'waitingRoomParticipant', 'waitingRoomRejected',
  'admitted', 'activeSpeakerChanged', 'forceMuted', 'errorEvent', 'heartbeatAck',
];

export class TestCallClient {
  socket!: Socket;
  device = new Device();
  sendTransport?: Transport;
  recvTransport?: Transport;
  producers = new Map<string, Producer>();
  consumers = new Map<string, Consumer>(); // keyed by producerId
  meetingId = '';
  events: CapturedEvent[] = [];
  autoConsume = true;
  private mediaElements: HTMLMediaElement[] = [];

  async connect(baseUrl: string, namespace: string, token: string): Promise<void> {
    // A second connect() call (scenario 14: reconnect after a simulated
    // network drop) means whatever transports/producers/consumers existed
    // on the old socket are dead — call-service's own reconnect path closes
    // them all server-side (docs/INTEGRATION.md §2.3 step 7: "producers and
    // consumers never survive a reconnect"), so reusing the stale client-side
    // references here would hand a since-deleted transportId to the next
    // produce()/consume() call ("Transport not found"). Mirrors the real
    // app's resetTransportState (meetings-demo-frontend/src/lib/callClient.ts).
    if (this.socket) {
      for (const producer of this.producers.values()) producer.close();
      this.producers.clear();
      for (const consumer of this.consumers.values()) consumer.close();
      this.consumers.clear();
      this.sendTransport?.close();
      this.recvTransport?.close();
      this.sendTransport = undefined;
      this.recvTransport = undefined;
    }

    this.socket = io(`${baseUrl}${namespace}`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 10000);
      this.socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('connect_error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    for (const event of BROADCAST_EVENTS) {
      this.socket.on(event, (payload: unknown) => {
        this.events.push({ event, payload, at: Date.now() });
        if (event === 'newProducer' && this.autoConsume) {
          const producerId = (payload as { producerId: string }).producerId;
          void this.consume(producerId).catch((err) => {
            this.events.push({ event: 'autoConsumeFailed', payload: { producerId, error: String(err) }, at: Date.now() });
          });
        }
      });
    }
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  async joinRoom(meetingId: string): Promise<Ack<{
    waiting: boolean;
    rtpCapabilities?: unknown;
    participants?: unknown[];
    meetingState?: unknown;
    iceServers?: unknown[];
    self?: unknown;
    existingProducers?: Array<{ producerId: string; peerId: string; kind: string; appData: unknown }>;
  }>> {
    this.meetingId = meetingId;
    const ack = await emitAck<{
      waiting: boolean;
      rtpCapabilities?: never;
      existingProducers?: Array<{ producerId: string; peerId: string; kind: string; appData: unknown }>;
    }>(this.socket, 'joinRoom', { meetingId });
    // Device.load() throws if called twice — matters on reconnect, where
    // joinRoom's server-side "existing participant" branch (see
    // SignalingService.joinRoom) returns rtpCapabilities again for the same
    // already-loaded Device.
    if (ack.success && ack.data && !ack.data.waiting && ack.data.rtpCapabilities && !this.device.loaded) {
      await this.device.load({ routerRtpCapabilities: ack.data.rtpCapabilities });
    }
    // Producers created before we joined don't fire `newProducer` — the join
    // response lists them separately (see SignalingService.buildJoinedResult)
    // and we consume them here the same way we'd handle a live newProducer.
    if (ack.success && ack.data && !ack.data.waiting && this.autoConsume) {
      for (const existing of ack.data.existingProducers ?? []) {
        void this.consume(existing.producerId).catch((err) => {
          this.events.push({
            event: 'autoConsumeFailed',
            payload: { producerId: existing.producerId, error: String(err) },
            at: Date.now(),
          });
        });
      }
    }
    return ack;
  }

  async leaveRoom(): Promise<Ack> {
    return emitAck(this.socket, 'leaveRoom', { meetingId: this.meetingId });
  }

  async ensureSendTransport(): Promise<Transport> {
    if (this.sendTransport) return this.sendTransport;
    const ack = await emitAck<{ id: string; iceParameters: unknown; iceCandidates: unknown; dtlsParameters: unknown }>(
      this.socket,
      'createTransport',
      { meetingId: this.meetingId, direction: 'send' },
    );
    if (!ack.success || !ack.data) throw new Error(ack.error ?? 'createTransport(send) failed');

    const transport = this.device.createSendTransport(ack.data as never);
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      emitAck(this.socket, 'connectTransport', { meetingId: this.meetingId, transportId: transport.id, dtlsParameters })
        .then((a) => (a.success ? callback() : errback(new Error(a.error))))
        .catch(errback);
    });
    transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      emitAck<{ id: string }>(this.socket, 'produce', {
        meetingId: this.meetingId,
        transportId: transport.id,
        kind,
        rtpParameters,
        appData,
      })
        .then((a) => (a.success && a.data ? callback({ id: a.data.id }) : errback(new Error(a.error))))
        .catch(errback);
    });
    transport.on('connectionstatechange', (state) => {
      this.events.push({ event: `sendTransport:${state}`, payload: {}, at: Date.now() });
    });

    this.sendTransport = transport;
    return transport;
  }

  async ensureRecvTransport(): Promise<Transport> {
    if (this.recvTransport) return this.recvTransport;
    const ack = await emitAck<{ id: string; iceParameters: unknown; iceCandidates: unknown; dtlsParameters: unknown }>(
      this.socket,
      'createTransport',
      { meetingId: this.meetingId, direction: 'recv' },
    );
    if (!ack.success || !ack.data) throw new Error(ack.error ?? 'createTransport(recv) failed');

    const transport = this.device.createRecvTransport(ack.data as never);
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      emitAck(this.socket, 'connectTransport', { meetingId: this.meetingId, transportId: transport.id, dtlsParameters })
        .then((a) => (a.success ? callback() : errback(new Error(a.error))))
        .catch(errback);
    });
    transport.on('connectionstatechange', (state) => {
      this.events.push({ event: `recvTransport:${state}`, payload: {}, at: Date.now() });
    });

    this.recvTransport = transport;
    return transport;
  }

  async produceMic(): Promise<string> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    const transport = await this.ensureSendTransport();
    const producer = await transport.produce({ track, appData: { source: 'mic' } });
    this.producers.set('mic', producer);
    return producer.id;
  }

  async produceCamera(): Promise<string> {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const track = stream.getVideoTracks()[0];
    const transport = await this.ensureSendTransport();
    const producer = await transport.produce({ track, appData: { source: 'camera' } });
    this.producers.set('camera', producer);
    return producer.id;
  }

  /**
   * Same as produceCamera but with 3-layer simulcast encodings (matches the
   * server's SIMULCAST_ENCODINGS reference, config/mediasoup.config.ts) —
   * used to verify the simulcast negotiation path actually works end to end.
   * Real bandwidth-constrained layer *switching* can't be forced in this
   * loopback/fake-media sandbox (nothing here is bandwidth constrained), so
   * this only proves multiple layers were negotiated, not that mediasoup's
   * bitrate adaptation logic activates under real network conditions.
   */
  async produceCameraSimulcast(): Promise<{ id: string; encodingCount: number }> {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const track = stream.getVideoTracks()[0];
    const transport = await this.ensureSendTransport();
    const producer = await transport.produce({
      track,
      appData: { source: 'camera' },
      encodings: [
        { rid: 'r0', maxBitrate: 100000, scalabilityMode: 'L1T3' },
        { rid: 'r1', maxBitrate: 300000, scalabilityMode: 'L1T3' },
        { rid: 'r2', maxBitrate: 900000, scalabilityMode: 'L1T3' },
      ],
    });
    this.producers.set('camera', producer);
    return { id: producer.id, encodingCount: producer.rtpParameters.encodings?.length ?? 0 };
  }

  /**
   * Headless Chromium has no real display to capture via getDisplayMedia, so
   * screen-share tests use a canvas-captured MediaStream as the source track
   * instead. call-service's screen-share logic keys off `appData.source ===
   * 'screen'`, not pixel content, so this exercises the real code path
   * (single-presenter enforcement, screenShareStarted/Stopped broadcasts)
   * without needing an actual screen.
   */
  async produceScreenShare(): Promise<string> {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d')!;
    let hue = 0;
    const draw = () => {
      ctx.fillStyle = `hsl(${(hue += 2) % 360}, 70%, 50%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      requestAnimationFrame(draw);
    };
    draw();

    const stream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(15);
    const track = stream.getVideoTracks()[0];
    const transport = await this.ensureSendTransport();
    const producer = await transport.produce({ track, appData: { source: 'screen' } });
    this.producers.set('screen', producer);
    return producer.id;
  }

  async consume(producerId: string): Promise<{ producerId: string; kind: string; mediaReceiving: boolean } | null> {
    if ([...this.consumers.values()].some((c) => c.producerId === producerId)) return null;

    const transport = await this.ensureRecvTransport();
    const ack = await emitAck<{
      id: string;
      producerId: string;
      kind: 'audio' | 'video';
      rtpParameters: unknown;
    }>(this.socket, 'consume', {
      meetingId: this.meetingId,
      transportId: transport.id,
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    });
    if (!ack.success || !ack.data) throw new Error(ack.error ?? 'consume failed');

    const consumer = await transport.consume({
      id: ack.data.id,
      producerId: ack.data.producerId,
      kind: ack.data.kind,
      rtpParameters: ack.data.rtpParameters as never,
    });
    this.consumers.set(producerId, consumer);

    // Note: mediasoup-client's Consumer has no built-in "the remote producer
    // was paused server-side" event — that's a server-side-only concept in
    // the `mediasoup` package's Consumer, not exposed to browsers by
    // mediasoup-client. The only real signal a client gets is whatever the
    // application's own signaling broadcasts (call-service's `audioMuted`/
    // `videoDisabled` events) — which is exactly what real clients key off,
    // so scenario tests assert against those broadcasts, not a nonexistent
    // client-side "producer paused" callback.
    await emitAck(this.socket, 'resumeConsumer', { meetingId: this.meetingId, consumerId: consumer.id });

    const mediaReceiving = await this.attachAndCheckMedia(consumer);
    const result = { producerId, kind: consumer.kind, mediaReceiving };
    // Recorded as an event (not just returned) so Node-side test code can
    // observe the outcome of auto-consumed producers too, via
    // eventsOfType('consumed') — auto-consume's return value is otherwise
    // discarded (see the `newProducer` handler in connect()).
    this.events.push({ event: 'consumed', payload: result, at: Date.now() });
    return result;
  }

  /** Attaches a consumer's track to a hidden media element and waits briefly to confirm real frames/samples arrive. */
  private async attachAndCheckMedia(consumer: Consumer): Promise<boolean> {
    const el = document.createElement(consumer.kind === 'video' ? 'video' : 'audio');
    el.srcObject = new MediaStream([consumer.track]);
    el.muted = true;
    (el as HTMLVideoElement).playsInline = true;
    document.body.appendChild(el);
    this.mediaElements.push(el);

    try {
      await el.play();
    } catch {
      // Autoplay can be blocked in some contexts; readyState check below still applies.
    }

    return new Promise<boolean>((resolve) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        if (el.readyState >= 2 /* HAVE_CURRENT_DATA */ && consumer.track.readyState === 'live') {
          resolve(true);
          return;
        }
        if (Date.now() > deadline) {
          resolve(false);
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  async pauseProducer(key: 'mic' | 'camera' | 'screen'): Promise<Ack> {
    const producer = this.producers.get(key);
    if (!producer) throw new Error(`No local producer for ${key}`);
    return emitAck(this.socket, 'pauseProducer', { meetingId: this.meetingId, producerId: producer.id });
  }

  async resumeProducer(key: 'mic' | 'camera' | 'screen'): Promise<Ack> {
    const producer = this.producers.get(key);
    if (!producer) throw new Error(`No local producer for ${key}`);
    return emitAck(this.socket, 'resumeProducer', { meetingId: this.meetingId, producerId: producer.id });
  }

  async closeProducer(key: 'mic' | 'camera' | 'screen'): Promise<Ack> {
    const producer = this.producers.get(key);
    if (!producer) throw new Error(`No local producer for ${key}`);
    const ack = await emitAck(this.socket, 'closeProducer', { meetingId: this.meetingId, producerId: producer.id });
    this.producers.delete(key);
    return ack;
  }

  async restartIce(transportKind: 'send' | 'recv'): Promise<Ack> {
    const transport = transportKind === 'send' ? this.sendTransport : this.recvTransport;
    if (!transport) throw new Error(`No ${transportKind} transport`);
    return emitAck(this.socket, 'restartIce', { meetingId: this.meetingId, transportId: transport.id });
  }

  /** Escape hatch for socket events with no dedicated wrapper below — always includes meetingId. */
  async emitEvent<T = unknown>(event: string, extra: Record<string, unknown> = {}): Promise<Ack<T>> {
    return emitAck(this.socket, event, { meetingId: this.meetingId, ...extra });
  }

  async raiseHand(): Promise<Ack> {
    return emitAck(this.socket, 'raiseHand', { meetingId: this.meetingId });
  }

  async lowerHand(): Promise<Ack> {
    return emitAck(this.socket, 'lowerHand', { meetingId: this.meetingId });
  }

  async sendReaction(emoji: string): Promise<Ack> {
    return emitAck(this.socket, 'reaction', { meetingId: this.meetingId, emoji });
  }

  async sendChatMessage(text: string): Promise<Ack> {
    return emitAck(this.socket, 'chatMessage', { meetingId: this.meetingId, text });
  }

  async startScreenShareReservation(): Promise<Ack> {
    return emitAck(this.socket, 'startScreenShare', { meetingId: this.meetingId });
  }

  async stopScreenShare(): Promise<Ack> {
    return emitAck(this.socket, 'stopScreenShare', { meetingId: this.meetingId });
  }

  async muteParticipant(targetUserId: string): Promise<Ack> {
    return emitAck(this.socket, 'mute', { meetingId: this.meetingId, targetUserId });
  }

  async requestUnmute(targetUserId: string): Promise<Ack> {
    return emitAck(this.socket, 'requestUnmute', { meetingId: this.meetingId, targetUserId });
  }

  async kickParticipant(targetUserId: string): Promise<Ack> {
    return emitAck(this.socket, 'kick', { meetingId: this.meetingId, targetUserId });
  }

  async promoteModerator(targetUserId: string): Promise<Ack> {
    return emitAck(this.socket, 'promoteModerator', { meetingId: this.meetingId, targetUserId });
  }

  async demoteModerator(targetUserId: string): Promise<Ack> {
    return emitAck(this.socket, 'demoteModerator', { meetingId: this.meetingId, targetUserId });
  }

  async lockMeeting(): Promise<Ack> {
    return emitAck(this.socket, 'lockMeeting', { meetingId: this.meetingId });
  }

  async unlockMeeting(): Promise<Ack> {
    return emitAck(this.socket, 'unlockMeeting', { meetingId: this.meetingId });
  }

  async disableFeature(feature: 'chat' | 'reactions' | 'screenShare', enabled: boolean): Promise<Ack> {
    return emitAck(this.socket, 'disableFeature', { meetingId: this.meetingId, feature, enabled });
  }

  async endMeeting(): Promise<Ack> {
    return emitAck(this.socket, 'endMeeting', { meetingId: this.meetingId });
  }

  async admitWaitingParticipant(targetUserId: string): Promise<Ack> {
    return emitAck(this.socket, 'admitWaitingParticipant', { meetingId: this.meetingId, targetUserId });
  }

  async rejectWaitingParticipant(targetUserId: string): Promise<Ack> {
    return emitAck(this.socket, 'rejectWaitingParticipant', { meetingId: this.meetingId, targetUserId });
  }

  /** Raw WebRTC stats from the underlying RTCPeerConnection — packetsLost/jitter live here. */
  async getSendTransportStats(): Promise<Record<string, unknown>[]> {
    if (!this.sendTransport) return [];
    const report = (await this.sendTransport.getStats()) as unknown as Map<string, Record<string, unknown>>;
    return [...report.values()];
  }

  async getRecvTransportStats(): Promise<Record<string, unknown>[]> {
    if (!this.recvTransport) return [];
    const report = (await this.recvTransport.getStats()) as unknown as Map<string, Record<string, unknown>>;
    return [...report.values()];
  }

  connectionState(kind: 'send' | 'recv'): string {
    const transport = kind === 'send' ? this.sendTransport : this.recvTransport;
    return transport?.connectionState ?? 'none';
  }

  getEvents(): CapturedEvent[] {
    return this.events;
  }

  eventsOfType(event: string): CapturedEvent[] {
    return this.events.filter((e) => e.event === event);
  }

  clearEvents(): void {
    this.events = [];
  }

  disconnect(): void {
    this.socket?.disconnect();
    for (const el of this.mediaElements) el.remove();
    this.mediaElements = [];
  }
}

declare global {
  interface Window {
    __client?: TestCallClient;
  }
}
