import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Meeting } from '../meeting/entities/meeting.entity';
import { ParticipantService } from '../participant/participant.service';
import { ProducerConsumerService } from '../mediasoup/producer-consumer.service';
import { RealtimeBroadcaster } from '../websocket/realtime-broadcaster.service';
import { ScreenShareService } from '../screen-share/screen-share.service';
import { Permission } from '../interfaces/permission.enum';
import { ParticipantRole } from '../interfaces/role.enum';
import { ServerEvent } from '../interfaces/socket-events.enum';
import { hasPermission } from './permissions.util';

export interface ModerationActor {
  /** Live requester role, or 'trusted' to bypass the permission check entirely
   *  (used for backend-initiated REST moderation, already authorized upstream). */
  role: ParticipantRole | 'trusted';
  userId?: string;
}

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    private readonly participants: ParticipantService,
    private readonly producerConsumer: ProducerConsumerService,
    private readonly broadcaster: RealtimeBroadcaster,
    private readonly screenShare: ScreenShareService,
  ) {}

  private assert(meeting: Meeting, actor: ModerationActor, permission: Permission): void {
    if (actor.role === 'trusted') return;
    if (!hasPermission(meeting, actor.role, permission)) {
      throw new ForbiddenException(`Missing permission: ${permission}`);
    }
  }

  async muteParticipant(meeting: Meeting, actor: ModerationActor, targetUserId: string): Promise<void> {
    this.assert(meeting, actor, Permission.MUTE_OTHERS);
    const target = this.participants.findByUserId(meeting, targetUserId);
    if (!target) throw new NotFoundException(`Participant ${targetUserId} not in meeting`);

    for (const producer of target.producers.values()) {
      if (producer.kind === 'audio') await this.producerConsumer.pauseProducer(producer);
    }
    target.audioMuted = true;

    this.broadcaster.emitToSocket(meeting.namespace, target.socketId, ServerEvent.FORCE_MUTED, {
      by: actor.userId,
    });
    this.broadcaster.emitToMeeting(meeting.namespace, meeting.id, ServerEvent.AUDIO_MUTED, {
      peerId: targetUserId,
      forced: true,
    });
  }

  /** Unmute can only be *requested* — mirrors Zoom/Meet: a host can silence you, never force your mic on. */
  requestUnmute(meeting: Meeting, actor: ModerationActor, targetUserId: string): void {
    this.assert(meeting, actor, Permission.REQUEST_UNMUTE);
    const target = this.participants.findByUserId(meeting, targetUserId);
    if (!target) throw new NotFoundException(`Participant ${targetUserId} not in meeting`);

    this.broadcaster.emitToSocket(meeting.namespace, target.socketId, ServerEvent.UNMUTE_REQUESTED, {
      by: actor.userId,
    });
  }

  removeParticipant(meeting: Meeting, actor: ModerationActor, targetUserId: string): void {
    this.assert(meeting, actor, Permission.REMOVE_PARTICIPANT);
    const target = this.participants.removeParticipant(meeting, targetUserId);
    if (!target) throw new NotFoundException(`Participant ${targetUserId} not in meeting`);

    this.broadcaster.emitToMeeting(meeting.namespace, meeting.id, ServerEvent.PARTICIPANT_REMOVED, {
      peerId: targetUserId,
      by: actor.userId,
    });
    this.broadcaster.disconnectSocket(meeting.namespace, target.socketId, 'You were removed from the meeting');
  }

  setLocked(meeting: Meeting, actor: ModerationActor, locked: boolean): void {
    this.assert(meeting, actor, Permission.LOCK_MEETING);
    meeting.locked = locked;
    this.broadcaster.emitToMeeting(
      meeting.namespace,
      meeting.id,
      locked ? ServerEvent.MEETING_LOCKED : ServerEvent.MEETING_UNLOCKED,
      { meetingId: meeting.id },
    );
  }

  setFeatureEnabled(
    meeting: Meeting,
    actor: ModerationActor,
    feature: 'chat' | 'reactions' | 'screenShare',
    enabled: boolean,
  ): void {
    const permissionMap: Record<typeof feature, Permission> = {
      chat: Permission.DISABLE_CHAT,
      reactions: Permission.DISABLE_REACTIONS,
      screenShare: Permission.DISABLE_SCREEN_SHARE,
    } as const;
    this.assert(meeting, actor, permissionMap[feature]);

    if (feature === 'chat') meeting.chatEnabled = enabled;
    if (feature === 'reactions') meeting.reactionsEnabled = enabled;
    if (feature === 'screenShare') {
      meeting.screenShareEnabled = enabled;
      if (!enabled) this.screenShare.forceStopActivePresenter(meeting);
    }

    this.broadcaster.emitToMeeting(
      meeting.namespace,
      meeting.id,
      ServerEvent.MEETING_STATE_UPDATED,
      meeting.toStateJSON(),
    );
  }

  promote(meeting: Meeting, actor: ModerationActor, targetUserId: string): void {
    this.assert(meeting, actor, Permission.PROMOTE_MODERATOR);
    const target = this.participants.promote(meeting, targetUserId);
    if (!target) throw new NotFoundException(`Participant ${targetUserId} not in meeting`);

    this.broadcaster.emitToMeeting(meeting.namespace, meeting.id, ServerEvent.PARTICIPANT_ROLE_CHANGED, {
      peerId: targetUserId,
      role: target.role,
    });
  }

  demote(meeting: Meeting, actor: ModerationActor, targetUserId: string): void {
    this.assert(meeting, actor, Permission.DEMOTE_MODERATOR);
    const target = this.participants.demote(meeting, targetUserId);
    if (!target) throw new NotFoundException(`Participant ${targetUserId} not in meeting`);

    this.broadcaster.emitToMeeting(meeting.namespace, meeting.id, ServerEvent.PARTICIPANT_ROLE_CHANGED, {
      peerId: targetUserId,
      role: target.role,
    });
  }

  lowerHand(meeting: Meeting, actor: ModerationActor, targetUserId: string): void {
    this.assert(meeting, actor, Permission.LOWER_HAND);
    const target = this.participants.findByUserId(meeting, targetUserId);
    if (!target) throw new NotFoundException(`Participant ${targetUserId} not in meeting`);

    target.handRaised = false;
    this.broadcaster.emitToMeeting(meeting.namespace, meeting.id, ServerEvent.HAND_LOWERED, {
      peerId: targetUserId,
    });
  }

  /** Lowers the participant's hand and invites them to unmute in one host action. */
  inviteToSpeak(meeting: Meeting, actor: ModerationActor, targetUserId: string): void {
    this.assert(meeting, actor, Permission.INVITE_TO_SPEAK);
    this.lowerHand(meeting, { ...actor, role: 'trusted' }, targetUserId);
    this.requestUnmute(meeting, { ...actor, role: 'trusted' }, targetUserId);
  }
}
