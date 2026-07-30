export enum TransportDirection {
  SEND = 'send',
  RECV = 'recv',
}

export interface ActiveSpeakerEvent {
  meetingId: string;
  peerId: string | null;
  volume?: number;
}
