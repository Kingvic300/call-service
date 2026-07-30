import { Inject, Injectable, Logger } from '@nestjs/common';
import { types as mediasoupTypes } from 'mediasoup';
import { MEDIASOUP_CONFIG } from '../config/config.module';
import { MediasoupAppConfig } from '../config/mediasoup.config';

export interface TransportParams {
  id: string;
  iceParameters: mediasoupTypes.IceParameters;
  iceCandidates: mediasoupTypes.IceCandidate[];
  dtlsParameters: mediasoupTypes.DtlsParameters;
}

@Injectable()
export class TransportService {
  private readonly logger = new Logger(TransportService.name);

  constructor(@Inject(MEDIASOUP_CONFIG) private readonly config: MediasoupAppConfig) {}

  async createWebRtcTransport(
    router: mediasoupTypes.Router,
    webRtcServer: mediasoupTypes.WebRtcServer,
    appData: Record<string, unknown>,
  ): Promise<mediasoupTypes.WebRtcTransport> {
    const { initialAvailableOutgoingBitrate, maxIncomingBitrate } = this.config.webRtcTransport;

    const transport = await router.createWebRtcTransport({
      webRtcServer,
      initialAvailableOutgoingBitrate,
      appData,
    });

    await transport.setMaxIncomingBitrate(maxIncomingBitrate).catch((err: Error) => {
      this.logger.warn(`setMaxIncomingBitrate failed for transport ${transport.id}: ${err.message}`);
    });

    transport.on('dtlsstatechange', (state) => {
      if (state === 'failed' || state === 'closed') {
        this.logger.warn(`Transport ${transport.id} DTLS state -> ${state}`);
      }
    });

    transport.on('icestatechange', (state) => {
      // mediasoup's IceState has no 'failed' — 'disconnected' is the terminal
      // failure signal here (ICE restart is the recovery path, see restartIce()).
      if (state === 'disconnected') {
        this.logger.warn(`Transport ${transport.id} ICE state -> ${state}`);
      }
    });

    return transport;
  }

  toParams(transport: mediasoupTypes.WebRtcTransport): TransportParams {
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connect(
    transport: mediasoupTypes.WebRtcTransport,
    dtlsParameters: mediasoupTypes.DtlsParameters,
  ): Promise<void> {
    await transport.connect({ dtlsParameters });
  }

  /** ICE restart on network switch / connectivity loss (spec: "ICE restart"). */
  async restartIce(transport: mediasoupTypes.WebRtcTransport): Promise<mediasoupTypes.IceParameters> {
    return transport.restartIce();
  }
}
