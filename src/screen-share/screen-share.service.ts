import { ForbiddenException, Injectable } from '@nestjs/common';
import { types as mediasoupTypes } from 'mediasoup';
import { Meeting } from '../meeting/entities/meeting.entity';
import { Participant } from '../participant/entities/participant.entity';
import { ProducerConsumerService } from '../mediasoup/producer-consumer.service';
import { RealtimeBroadcaster } from '../websocket/realtime-broadcaster.service';
import { ServerEvent } from '../interfaces/socket-events.enum';

/** Producer appData marker used to distinguish a screen-share video track from the camera. */
export const SCREEN_SHARE_SOURCE = 'screen';

/**
 * Enforces "only one active presentation at a time" (spec) and broadcasts
 * start/stop to every participant so viewer UIs can switch layouts.
 */
@Injectable()
export class ScreenShareService {
  constructor(
    private readonly producerConsumer: ProducerConsumerService,
    private readonly broadcaster: RealtimeBroadcaster,
  ) {}

  /** Call before accepting a produce() call whose appData.source === SCREEN_SHARE_SOURCE. */
  assertCanStart(meeting: Meeting, userId: string): void {
    if (!meeting.screenShareEnabled) {
      throw new ForbiddenException(
        'Screen sharing is disabled in this meeting',
      );
    }
    if (meeting.activePresenterId && meeting.activePresenterId !== userId) {
      throw new ForbiddenException('Another participant is already presenting');
    }
  }

  onStarted(meeting: Meeting, participant: Participant): void {
    meeting.activePresenterId = participant.userId;
    participant.presenting = true;
    this.broadcaster.emitToMeeting(
      meeting.namespace,
      meeting.id,
      ServerEvent.SCREEN_SHARE_STARTED,
      {
        peerId: participant.userId,
      },
    );
  }

  onStopped(meeting: Meeting, participant: Participant): void {
    if (meeting.activePresenterId === participant.userId) {
      meeting.activePresenterId = null;
    }
    participant.presenting = false;
    this.broadcaster.emitToMeeting(
      meeting.namespace,
      meeting.id,
      ServerEvent.SCREEN_SHARE_STOPPED,
      {
        peerId: participant.userId,
      },
    );
  }

  /** Used by ModerationService when a host disables screen sharing mid-meeting. */
  forceStopActivePresenter(meeting: Meeting): void {
    if (!meeting.activePresenterId) return;
    const presenter = meeting.participants.get(meeting.activePresenterId);
    if (!presenter) {
      meeting.activePresenterId = null;
      return;
    }

    for (const producer of presenter.producers.values()) {
      if (isScreenShareProducer(producer))
        this.producerConsumer.closeProducer(producer);
    }
    this.onStopped(meeting, presenter);
  }
}

export function isScreenShareProducer(
  producer: mediasoupTypes.Producer,
): boolean {
  return producer.appData?.source === SCREEN_SHARE_SOURCE;
}
