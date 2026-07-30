import { types as mediasoupTypes } from 'mediasoup';
import { ParticipantRole } from '../../interfaces/role.enum';

/**
 * Live in-memory state for one connected peer inside one meeting. Owns the
 * mediasoup transports/producers/consumers for that peer — in an SFU, the
 * server-side peer object is naturally the right place for these, since
 * they're server-local resources the client only ever references by id.
 */
export class Participant {
  readonly userId: string;
  socketId: string;
  displayName: string;
  avatarUrl?: string;
  role: ParticipantRole;
  readonly meetingId: string;
  readonly joinedAt: Date;

  audioMuted = true;
  videoEnabled = false;
  handRaised = false;
  presenting = false;
  /** Set on disconnect; cleared if the peer reconnects within the grace period. */
  pendingLeaveTimer?: NodeJS.Timeout;

  readonly transports = new Map<string, mediasoupTypes.WebRtcTransport>();
  /** producerId -> Producer */
  readonly producers = new Map<string, mediasoupTypes.Producer>();
  /** consumerId -> Consumer */
  readonly consumers = new Map<string, mediasoupTypes.Consumer>();
  rtpCapabilities?: mediasoupTypes.RtpCapabilities;

  constructor(params: {
    userId: string;
    socketId: string;
    displayName: string;
    avatarUrl?: string;
    role: ParticipantRole;
    meetingId: string;
  }) {
    this.userId = params.userId;
    this.socketId = params.socketId;
    this.displayName = params.displayName;
    this.avatarUrl = params.avatarUrl;
    this.role = params.role;
    this.meetingId = params.meetingId;
    this.joinedAt = new Date();
  }

  addTransport(transport: mediasoupTypes.WebRtcTransport): void {
    this.transports.set(transport.id, transport);
  }

  addProducer(producer: mediasoupTypes.Producer): void {
    this.producers.set(producer.id, producer);
  }

  addConsumer(consumer: mediasoupTypes.Consumer): void {
    this.consumers.set(consumer.id, consumer);
  }

  findProducer(producerId: string): mediasoupTypes.Producer | undefined {
    return this.producers.get(producerId);
  }

  /** Closes every mediasoup resource owned by this peer (transports cascade-close producers/consumers). */
  closeAllMedia(): void {
    for (const transport of this.transports.values()) {
      if (!transport.closed) transport.close();
    }
    this.transports.clear();
    this.producers.clear();
    this.consumers.clear();
  }

  toPublicJSON() {
    return {
      userId: this.userId,
      displayName: this.displayName,
      avatarUrl: this.avatarUrl,
      role: this.role,
      audioMuted: this.audioMuted,
      videoEnabled: this.videoEnabled,
      handRaised: this.handRaised,
      presenting: this.presenting,
      joinedAt: this.joinedAt.toISOString(),
    };
  }
}
