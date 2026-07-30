import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { types as mediasoupTypes } from 'mediasoup';

export interface ConsumerParams {
  id: string;
  producerId: string;
  kind: mediasoupTypes.MediaKind;
  rtpParameters: mediasoupTypes.RtpParameters;
  producerPaused: boolean;
}

@Injectable()
export class ProducerConsumerService {
  private readonly logger = new Logger(ProducerConsumerService.name);

  async produce(
    transport: mediasoupTypes.WebRtcTransport,
    params: {
      kind: mediasoupTypes.MediaKind;
      rtpParameters: mediasoupTypes.RtpParameters;
      appData: Record<string, unknown>;
    },
  ): Promise<mediasoupTypes.Producer> {
    const producer = await transport.produce({
      kind: params.kind,
      rtpParameters: params.rtpParameters,
      appData: params.appData,
    });

    producer.on('transportclose', () => {
      this.logger.debug(`Producer ${producer.id} closed (transport closed)`);
    });

    return producer;
  }

  /**
   * Creates a paused consumer (mediasoup best practice: client resumes it via
   * `resumeConsumer` once its media element is ready, avoiding a burst of
   * packets the client can't render yet).
   */
  async consume(
    router: mediasoupTypes.Router,
    transport: mediasoupTypes.WebRtcTransport,
    producer: mediasoupTypes.Producer,
    rtpCapabilities: mediasoupTypes.RtpCapabilities,
    appData: Record<string, unknown>,
  ): Promise<{ consumer: mediasoupTypes.Consumer; params: ConsumerParams }> {
    if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      throw new BadRequestException(
        `Client RTP capabilities cannot consume producer ${producer.id}`,
      );
    }

    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true,
      appData,
    });

    return {
      consumer,
      params: {
        id: consumer.id,
        producerId: producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        producerPaused: consumer.producerPaused,
      },
    };
  }

  async pauseProducer(producer: mediasoupTypes.Producer): Promise<void> {
    if (!producer.paused) await producer.pause();
  }

  async resumeProducer(producer: mediasoupTypes.Producer): Promise<void> {
    if (producer.paused) await producer.resume();
  }

  closeProducer(producer: mediasoupTypes.Producer): void {
    if (!producer.closed) producer.close();
  }

  async resumeConsumer(consumer: mediasoupTypes.Consumer): Promise<void> {
    if (consumer.paused) await consumer.resume();
  }

  /**
   * Requests a lower/higher simulcast spatial+temporal layer from a consumer
   * — used to automatically downgrade quality for participants who aren't
   * currently visible/active (spec: "Automatically reduce quality for
   * inactive participants") without renegotiating the producer at all.
   */
  async setPreferredLayers(
    consumer: mediasoupTypes.Consumer,
    spatialLayer: number,
    temporalLayer = 2,
  ): Promise<void> {
    if (consumer.kind !== 'video') return;
    await consumer.setPreferredLayers({ spatialLayer, temporalLayer }).catch((err: Error) => {
      this.logger.debug(`setPreferredLayers failed for consumer ${consumer.id}: ${err.message}`);
    });
  }
}
