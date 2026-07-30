import { Injectable, Logger } from '@nestjs/common';
import { Meeting } from '../meeting/entities/meeting.entity';
import { ParticipantRole } from '../interfaces/role.enum';
import { Participant } from './entities/participant.entity';

@Injectable()
export class ParticipantService {
  private readonly logger = new Logger(ParticipantService.name);

  resolveRole(meeting: Meeting, userId: string): ParticipantRole {
    if (userId === meeting.hostId) return ParticipantRole.HOST;
    return ParticipantRole.PARTICIPANT;
  }

  addParticipant(meeting: Meeting, participant: Participant): void {
    meeting.participants.set(participant.userId, participant);
  }

  removeParticipant(meeting: Meeting, userId: string): Participant | undefined {
    const participant = meeting.participants.get(userId);
    if (!participant) return undefined;
    participant.closeAllMedia();
    meeting.participants.delete(userId);
    return participant;
  }

  findByUserId(meeting: Meeting, userId: string): Participant | undefined {
    return meeting.participants.get(userId);
  }

  findBySocketId(meeting: Meeting, socketId: string): Participant | undefined {
    for (const p of meeting.participants.values()) {
      if (p.socketId === socketId) return p;
    }
    return undefined;
  }

  list(meeting: Meeting): Participant[] {
    return Array.from(meeting.participants.values());
  }

  promote(meeting: Meeting, userId: string): Participant | undefined {
    const participant = meeting.participants.get(userId);
    if (!participant || participant.role === ParticipantRole.HOST) return participant;
    participant.role = ParticipantRole.MODERATOR;
    return participant;
  }

  demote(meeting: Meeting, userId: string): Participant | undefined {
    const participant = meeting.participants.get(userId);
    if (!participant || participant.role === ParticipantRole.HOST) return participant;
    participant.role = ParticipantRole.PARTICIPANT;
    return participant;
  }
}
