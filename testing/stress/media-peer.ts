import './webrtc-shim.js';
import { werift } from './webrtc-shim.js';
import { Device } from 'mediasoup-client';
import type { Transport } from 'mediasoup-client/types';
import { io, Socket } from 'socket.io-client';
import { config } from '../lib/config.js';

export interface NetworkImpairment {
  /** 0-1, fraction of outgoing packets silently dropped before send. */
  lossRate?: number;
  /** ms of artificial one-way delay added before each outgoing packet is actually sent. */
  latencyMs?: number;
}

export interface MetricSample {
  t: number;
  event: string;
  ok: boolean;
  ms?: number;
  detail?: string;
}

function ack<T>(socket: Socket, event: string, payload: unknown, timeoutMs = 10000): Promise<{ success: boolean; data?: T; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs);
    socket.emit(event, payload, (r: { success: boolean; data?: T; error?: string }) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
}

/**
 * A real WebRTC participant running in plain Node (no browser) via werift.
 * Produces genuinely SRTP-encrypted, mediasoup-relayed audio/video — see
 * webrtc-shim.ts's doc comment for how that's actually true and not a
 * simulation. Used by stress/worker-process.ts to run many of these per OS
 * process.
 */
export class MediaPeer {
  socket!: Socket;
  device = new Device();
  sendTransport?: Transport;
  recvTransport?: Transport;
  producers = new Map<string, { producer: import('mediasoup-client/types').Producer; interval: NodeJS.Timeout }>();
  consumers = new Set<string>(); // producerIds already consumed
  meetingId = '';
  userId: string;
  samples: MetricSample[] = [];
  /** Bounded selective consumption — real large meetings don't fan every producer out to every viewer either. */
  maxConsume: number;
  impairment: NetworkImpairment;
  private closed = false;

  constructor(
    userId: string,
    opts: { maxConsume?: number; impairment?: NetworkImpairment } = {},
  ) {
    this.userId = userId;
    this.maxConsume = opts.maxConsume ?? 15;
    this.impairment = opts.impairment ?? {};
  }

  private record(event: string, ok: boolean, ms?: number, detail?: string) {
    this.samples.push({ t: Date.now(), event, ok, ms, detail });
  }

  async connect(namespace: '/calls' | '/meetings' = '/meetings'): Promise<void> {
    const start = Date.now();
    this.socket = io(`${config.callServiceWsUrl}${namespace}`, {
      auth: { apiKey: config.apiKey, secretKey: config.secretKey, userId: this.userId, displayName: this.userId },
      transports: ['websocket'],
      reconnection: false,
      timeout: 10000,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), 10000);
      this.socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('connect_error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    this.record('connect', true, Date.now() - start);

    this.socket.on('newProducer', (payload: { producerId: string; peerId: string }) => {
      if (this.consumers.size < this.maxConsume) {
        void this.consume(payload.producerId).catch((err) => this.record('autoConsumeFailed', false, undefined, String(err)));
      }
    });
  }

  async joinRoom(meetingId: string, turnOnly = false): Promise<{ success: boolean; error?: string; iceServers?: unknown[] }> {
    this.meetingId = meetingId;
    const start = Date.now();
    const res = await ack<{
      waiting: boolean;
      rtpCapabilities?: unknown;
      iceServers?: unknown[];
      existingProducers?: Array<{ producerId: string }>;
    }>(this.socket, 'joinRoom', { meetingId });
    this.record('joinRoom', res.success, Date.now() - start, res.error);
    if (!res.success || !res.data) return { success: false, error: res.error };

    if (!res.data.waiting && res.data.rtpCapabilities && !this.device.loaded) {
      await this.device.load({ routerRtpCapabilities: res.data.rtpCapabilities as never });
    }
    this.turnOnly = turnOnly;
    this.iceServers = res.data.iceServers;

    for (const existing of res.data.existingProducers ?? []) {
      if (this.consumers.size < this.maxConsume) {
        void this.consume(existing.producerId).catch((err) => this.record('autoConsumeFailed', false, undefined, String(err)));
      }
    }
    return { success: true, iceServers: res.data.iceServers };
  }

  private turnOnly = false;
  private iceServers: unknown[] | undefined;

  async ensureSendTransport(): Promise<Transport> {
    if (this.sendTransport) return this.sendTransport;
    const start = Date.now();
    const res = await ack<{ id: string }>(this.socket, 'createTransport', { meetingId: this.meetingId, direction: 'send' });
    this.record('createTransport:send', res.success, Date.now() - start, res.error);
    if (!res.success || !res.data) throw new Error(res.error ?? 'createTransport(send) failed');

    const transport = this.device.createSendTransport({
      ...(res.data as object),
      ...(this.turnOnly ? { iceServers: this.iceServers, iceTransportPolicy: 'relay' } : {}),
    } as never);
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      ack(this.socket, 'connectTransport', { meetingId: this.meetingId, transportId: transport.id, dtlsParameters })
        .then((a) => (a.success ? callback() : errback(new Error(a.error))))
        .catch(errback);
    });
    transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      ack<{ id: string }>(this.socket, 'produce', { meetingId: this.meetingId, transportId: transport.id, kind, rtpParameters, appData })
        .then((a) => (a.success && a.data ? callback({ id: a.data.id }) : errback(new Error(a.error))))
        .catch(errback);
    });
    this.sendTransport = transport;
    return transport;
  }

  async ensureRecvTransport(): Promise<Transport> {
    if (this.recvTransport) return this.recvTransport;
    const res = await ack<{ id: string }>(this.socket, 'createTransport', { meetingId: this.meetingId, direction: 'recv' });
    if (!res.success || !res.data) throw new Error(res.error ?? 'createTransport(recv) failed');

    const transport = this.device.createRecvTransport({
      ...(res.data as object),
      ...(this.turnOnly ? { iceServers: this.iceServers, iceTransportPolicy: 'relay' } : {}),
    } as never);
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      ack(this.socket, 'connectTransport', { meetingId: this.meetingId, transportId: transport.id, dtlsParameters })
        .then((a) => (a.success ? callback() : errback(new Error(a.error))))
        .catch(errback);
    });
    this.recvTransport = transport;
    return transport;
  }

  /** Real RTP, real SRTP encryption, genuine mediasoup relay — content is synthetic, cadence/size is realistic. */
  private startRtpSource(track: InstanceType<typeof werift.MediaStreamTrack>, ssrc: number, payloadType: number, kind: 'audio' | 'video') {
    let seq = 0;
    let ts = 0;
    const stepMs = kind === 'audio' ? 20 : 33; // audio: 20ms/frame (Opus); video: ~30fps
    const clockStep = kind === 'audio' ? 960 : 2880; // 48kHz steps matching stepMs
    const payloadSize = kind === 'audio' ? 80 : 900; // representative Opus vs. VP8 frame size
    const send = () => {
      if (this.closed) return;
      const doSend = () => {
        if (this.impairment.lossRate && Math.random() < this.impairment.lossRate) return; // simulated loss
        const header = new werift.RtpHeader({ payloadType, sequenceNumber: seq++ % 65536, timestamp: ts, ssrc, marker: kind === 'video' });
        track.writeRtp(new werift.RtpPacket(header, Buffer.alloc(payloadSize, 0xaa)));
      };
      ts += clockStep;
      if (this.impairment.latencyMs) setTimeout(doSend, this.impairment.latencyMs);
      else doSend();
    };
    return setInterval(send, stepMs);
  }

  async produceMic(): Promise<string> {
    const transport = await this.ensureSendTransport();
    const track = new werift.MediaStreamTrack({ kind: 'audio' });
    const start = Date.now();
    const producer = await transport.produce({ track: track as unknown as MediaStreamTrack, appData: { source: 'mic' } });
    this.record('produce:audio', true, Date.now() - start);
    const encoding = producer.rtpParameters.encodings![0];
    const payloadType = producer.rtpParameters.codecs[0].payloadType;
    const interval = this.startRtpSource(track, encoding.ssrc!, payloadType, 'audio');
    this.producers.set('mic', { producer, interval });
    return producer.id;
  }

  async produceCamera(): Promise<string> {
    const transport = await this.ensureSendTransport();
    const track = new werift.MediaStreamTrack({ kind: 'video' });
    const start = Date.now();
    const producer = await transport.produce({ track: track as unknown as MediaStreamTrack, appData: { source: 'camera' } });
    this.record('produce:video', true, Date.now() - start);
    const encoding = producer.rtpParameters.encodings![0];
    const payloadType = producer.rtpParameters.codecs[0].payloadType;
    const interval = this.startRtpSource(track, encoding.ssrc!, payloadType, 'video');
    this.producers.set('camera', { producer, interval });
    return producer.id;
  }

  async produceScreenShare(): Promise<string> {
    const transport = await this.ensureSendTransport();
    const track = new werift.MediaStreamTrack({ kind: 'video' });
    const producer = await transport.produce({ track: track as unknown as MediaStreamTrack, appData: { source: 'screen' } });
    const encoding = producer.rtpParameters.encodings![0];
    const payloadType = producer.rtpParameters.codecs[0].payloadType;
    const interval = this.startRtpSource(track, encoding.ssrc!, payloadType, 'video');
    this.producers.set('screen', { producer, interval });
    return producer.id;
  }

  async pauseProducer(key: 'mic' | 'camera' | 'screen'): Promise<boolean> {
    const entry = this.producers.get(key);
    if (!entry) return false;
    const start = Date.now();
    const res = await ack(this.socket, 'pauseProducer', { meetingId: this.meetingId, producerId: entry.producer.id });
    this.record('pauseProducer', res.success, Date.now() - start, res.error);
    return res.success;
  }

  async resumeProducer(key: 'mic' | 'camera' | 'screen'): Promise<boolean> {
    const entry = this.producers.get(key);
    if (!entry) return false;
    const start = Date.now();
    const res = await ack(this.socket, 'resumeProducer', { meetingId: this.meetingId, producerId: entry.producer.id });
    this.record('resumeProducer', res.success, Date.now() - start, res.error);
    return res.success;
  }

  async closeProducer(key: 'mic' | 'camera' | 'screen'): Promise<boolean> {
    const entry = this.producers.get(key);
    if (!entry) return false;
    clearInterval(entry.interval);
    const res = await ack(this.socket, 'closeProducer', { meetingId: this.meetingId, producerId: entry.producer.id });
    this.producers.delete(key);
    this.record('closeProducer', res.success, undefined, res.error);
    return res.success;
  }

  async consume(producerId: string): Promise<void> {
    if (this.consumers.has(producerId)) return;
    this.consumers.add(producerId);
    const transport = await this.ensureRecvTransport();
    const start = Date.now();
    const res = await ack<{ id: string; producerId: string; kind: 'audio' | 'video'; rtpParameters: unknown }>(
      this.socket,
      'consume',
      { meetingId: this.meetingId, transportId: transport.id, producerId, rtpCapabilities: this.device.rtpCapabilities },
    );
    this.record('consume', res.success, Date.now() - start, res.error);
    if (!res.success || !res.data) return;
    const consumer = await transport.consume({
      id: res.data.id,
      producerId: res.data.producerId,
      kind: res.data.kind,
      rtpParameters: res.data.rtpParameters as never,
    });
    await ack(this.socket, 'resumeConsumer', { meetingId: this.meetingId, consumerId: consumer.id });
  }

  async emitEvent<T = unknown>(event: string, extra: Record<string, unknown> = {}): Promise<{ success: boolean; data?: T; error?: string }> {
    const start = Date.now();
    const res = await ack<T>(this.socket, event, { meetingId: this.meetingId, ...extra });
    this.record(event, res.success, Date.now() - start, res.error);
    return res;
  }

  async getSendStats(): Promise<Record<string, unknown>[]> {
    if (!this.sendTransport) return [];
    const report = (await this.sendTransport.getStats()) as unknown as Map<string, Record<string, unknown>>;
    return [...report.values()];
  }

  async getRecvStats(): Promise<Record<string, unknown>[]> {
    if (!this.recvTransport) return [];
    const report = (await this.recvTransport.getStats()) as unknown as Map<string, Record<string, unknown>>;
    return [...report.values()];
  }

  connectionState(kind: 'send' | 'recv'): string {
    return (kind === 'send' ? this.sendTransport : this.recvTransport)?.connectionState ?? 'none';
  }

  disconnect(): void {
    for (const { interval } of this.producers.values()) clearInterval(interval);
    this.producers.clear();
    this.socket?.disconnect();
  }

  close(): void {
    this.closed = true;
    this.disconnect();
  }
}
