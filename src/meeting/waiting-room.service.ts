import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Meeting, WaitingParticipant } from './entities/meeting.entity';
import { RealtimeBroadcaster } from '../websocket/realtime-broadcaster.service';
import { ServerEvent } from '../interfaces/socket-events.enum';
import { Permission } from '../interfaces/permission.enum';
import { ParticipantRole } from '../interfaces/role.enum';
import { hasPermission } from '../moderation/permissions.util';

/**
 * Architecture for the waiting room (spec: "Waiting Room — architecture
 * only"). Fully wired end-to-end here since the mechanics are simple (a
 * side map + admit/reject), but it's a first participant *gate*, not a
 * general-purpose meeting feature — it never touches mediasoup state,
 * since a waiting participant has no transports/producers yet.
 */
@Injectable()
export class WaitingRoomService {
  constructor(private readonly broadcaster: RealtimeBroadcaster) {}

  add(meeting: Meeting, entry: WaitingParticipant): void {
    meeting.waitingParticipants.set(entry.userId, entry);
    this.broadcaster.emitToSocket(meeting.namespace, entry.socketId, ServerEvent.WAITING_ROOM_JOINED, {
      meetingId: meeting.id,
    });
    this.notifyHosts(meeting, entry);
  }

  private notifyHosts(meeting: Meeting, entry: WaitingParticipant): void {
    for (const participant of meeting.participants.values()) {
      if (participant.role === ParticipantRole.HOST || participant.role === ParticipantRole.MODERATOR) {
        this.broadcaster.emitToSocket(
          meeting.namespace,
          participant.socketId,
          ServerEvent.WAITING_ROOM_PARTICIPANT,
          { userId: entry.userId, displayName: entry.displayName, avatarUrl: entry.avatarUrl },
        );
      }
    }
  }

  admit(meeting: Meeting, requesterRole: ParticipantRole, targetUserId: string): WaitingParticipant {
    if (!hasPermission(meeting, requesterRole, Permission.MANAGE_WAITING_ROOM)) {
      throw new ForbiddenException('Missing permission: manage_waiting_room');
    }
    const entry = meeting.waitingParticipants.get(targetUserId);
    if (!entry) throw new NotFoundException(`${targetUserId} is not in the waiting room`);
    meeting.waitingParticipants.delete(targetUserId);
    return entry;
  }

  reject(meeting: Meeting, requesterRole: ParticipantRole, targetUserId: string): void {
    if (!hasPermission(meeting, requesterRole, Permission.MANAGE_WAITING_ROOM)) {
      throw new ForbiddenException('Missing permission: manage_waiting_room');
    }
    const entry = meeting.waitingParticipants.get(targetUserId);
    if (!entry) throw new NotFoundException(`${targetUserId} is not in the waiting room`);
    meeting.waitingParticipants.delete(targetUserId);
    this.broadcaster.emitToSocket(meeting.namespace, entry.socketId, ServerEvent.WAITING_ROOM_REJECTED, {
      meetingId: meeting.id,
    });
    this.broadcaster.disconnectSocket(meeting.namespace, entry.socketId);
  }
}
