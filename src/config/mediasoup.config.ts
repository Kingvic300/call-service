import * as os from 'os';
import { types as mediasoupTypes } from 'mediasoup';
import { ConfigService } from '@nestjs/config';

export interface MediasoupAppConfig {
  numWorkers: number;
  worker: mediasoupTypes.WorkerSettings;
  router: { mediaCodecs: mediasoupTypes.RouterRtpCodecCapability[] };
  /** Single shared UDP+TCP port every WebRtcServer (one per worker) listens on. */
  webRtcServerListenInfos: mediasoupTypes.TransportListenInfo[];
  webRtcTransport: {
    initialAvailableOutgoingBitrate: number;
    maxIncomingBitrate: number;
  };
}

/** Standard mediasoup codec set: Opus for audio, VP8/VP9/H264 for video (per spec). */
const MEDIA_CODECS: mediasoupTypes.RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: { useinbandfec: 1 },
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: { 'profile-id': 2, 'x-google-start-bitrate': 1000 },
  },
  {
    kind: 'video',
    mimeType: 'video/h264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
  },
];

export function buildMediasoupConfig(
  config: ConfigService,
): MediasoupAppConfig {
  const numWorkers =
    config.get<number>('MEDIASOUP_NUM_WORKERS') ?? os.cpus().length;
  const listenIp = config.get<string>('MEDIASOUP_LISTEN_IP', '0.0.0.0');
  const announcedAddress = config.getOrThrow<string>('MEDIASOUP_ANNOUNCED_IP');
  const webRtcPort = config.get<number>('MEDIASOUP_WEBRTC_PORT', 44000);

  return {
    numWorkers,
    worker: {
      logLevel: config.get<string>(
        'MEDIASOUP_LOG_LEVEL',
        'warn',
      ) as mediasoupTypes.WorkerLogLevel,
      // Only used as a fallback for transports created without a WebRtcServer
      // (none currently are — every WebRtcTransport this service creates goes
      // through the single shared port below). Kept narrow since it's unused
      // in the normal path.
      rtcMinPort: config.get<number>('MEDIASOUP_MIN_PORT', 40000),
      rtcMaxPort: config.get<number>('MEDIASOUP_MAX_PORT', 40009),
    },
    router: {
      mediaCodecs: MEDIA_CODECS,
    },
    // One UDP + one TCP listener, same port, shared by every WebRtcTransport
    // in the process (mediasoup's WebRtcServer API) — deliberately NOT a big
    // per-transport port range. This is what makes the service deployable
    // behind a plain cloud firewall / a single Docker port mapping instead of
    // publishing thousands of ports (see docs/DEPLOYMENT.md).
    webRtcServerListenInfos: [
      { protocol: 'udp', ip: listenIp, announcedAddress, port: webRtcPort },
      { protocol: 'tcp', ip: listenIp, announcedAddress, port: webRtcPort },
    ],
    webRtcTransport: {
      initialAvailableOutgoingBitrate: config.get<number>(
        'MEDIASOUP_INITIAL_AVAILABLE_OUTGOING_BITRATE',
        800000,
      ),
      maxIncomingBitrate: config.get<number>(
        'MEDIASOUP_MAX_INCOMING_BITRATE',
        1500000,
      ),
    },
  };
}

/**
 * 3-layer simulcast reference encoding for outgoing video producers (spec:
 * "Implement simulcast"). This is a client-side reference — the browser
 * decides the actual `encodings` sent with `produce()` (mediasoup's
 * `RtpEncodingParameters` no longer carries `scaleResolutionDownBy`; that's
 * purely a `getUserMedia`/`RTCRtpSender` concern client-side), but the
 * `rid`/`maxBitrate`/`scalabilityMode` shape here matches what mediasoup
 * expects to receive and is exactly what mediasoup-client's `simulcast: true`
 * option produces.
 */
export const SIMULCAST_ENCODINGS: mediasoupTypes.RtpEncodingParameters[] = [
  { rid: 'r0', maxBitrate: 100000, scalabilityMode: 'L1T3' },
  { rid: 'r1', maxBitrate: 300000, scalabilityMode: 'L1T3' },
  { rid: 'r2', maxBitrate: 900000, scalabilityMode: 'L1T3' },
];
