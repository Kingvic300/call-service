import { MeetingMode, MeetingType } from '../../interfaces/meeting-type.enum';
import { Permission } from '../../interfaces/permission.enum';
import { Participant } from '../../participant/entities/participant.entity';

export interface WaitingParticipant {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  socketId: string;
  requestedAt: Date;
}

/** Socket.IO namespace each meeting type is served on — see RealtimeBroadcaster. */
export const NAMESPACE_BY_TYPE: Record<MeetingType, string> = {
  [MeetingType.ONE_TO_ONE]: '/calls',
  [MeetingType.GROUP]: '/meetings',
};

export class Meeting {
  readonly id: string;
  readonly hostId: string;
  readonly type: MeetingType;
  readonly mode: MeetingMode;
  readonly namespace: string;
  readonly createdAt: Date;
  endedAt?: Date;

  locked = false;
  chatEnabled = true;
  reactionsEnabled = true;
  screenShareEnabled = true;
  waitingRoomEnabled = false;

  /** Per-meeting permission overrides layered on top of DEFAULT_ROLE_PERMISSIONS. */
  readonly permissionOverrides = new Map<Permission, boolean>();

  activePresenterId: string | null = null;

  readonly participants = new Map<string, Participant>();
  readonly waitingParticipants = new Map<string, WaitingParticipant>();

  constructor(params: {
    id: string;
    hostId: string;
    type: MeetingType;
    mode: MeetingMode;
    waitingRoomEnabled?: boolean;
    chatEnabled?: boolean;
    reactionsEnabled?: boolean;
    screenShareEnabled?: boolean;
  }) {
    this.id = params.id;
    this.hostId = params.hostId;
    this.type = params.type;
    this.mode = params.mode;
    this.namespace = NAMESPACE_BY_TYPE[params.type];
    this.createdAt = new Date();
    this.waitingRoomEnabled = params.waitingRoomEnabled ?? false;
    this.chatEnabled = params.chatEnabled ?? true;
    this.reactionsEnabled = params.reactionsEnabled ?? true;
    this.screenShareEnabled = params.screenShareEnabled ?? true;
  }

  get isEnded(): boolean {
    return this.endedAt !== undefined;
  }

  get participantCount(): number {
    return this.participants.size;
  }

  toStateJSON() {
    return {
      id: this.id,
      type: this.type,
      mode: this.mode,
      locked: this.locked,
      chatEnabled: this.chatEnabled,
      reactionsEnabled: this.reactionsEnabled,
      screenShareEnabled: this.screenShareEnabled,
      waitingRoomEnabled: this.waitingRoomEnabled,
      activePresenterId: this.activePresenterId,
      participantCount: this.participantCount,
    };
  }
}
