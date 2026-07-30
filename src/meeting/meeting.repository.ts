import { Injectable } from '@nestjs/common';
import { Meeting } from './entities/meeting.entity';

export const MEETING_REPOSITORY = 'MEETING_REPOSITORY';

export interface IMeetingRepository {
  save(meeting: Meeting): void;
  findById(id: string): Meeting | undefined;
  delete(id: string): void;
  list(): Meeting[];
}

/**
 * In-memory store — fine for a single instance. Horizontally scaling this
 * service across multiple processes/nodes would need a shared store (Redis)
 * behind this same interface, plus routing each meeting's traffic to
 * whichever instance holds its mediasoup Router (mediasoup state itself
 * can never be shared across processes). Kept behind an interface + DI
 * token specifically so that swap doesn't touch call sites. See README
 * "Horizontal scaling" section.
 */
@Injectable()
export class InMemoryMeetingRepository implements IMeetingRepository {
  private readonly meetings = new Map<string, Meeting>();

  save(meeting: Meeting): void {
    this.meetings.set(meeting.id, meeting);
  }

  findById(id: string): Meeting | undefined {
    return this.meetings.get(id);
  }

  delete(id: string): void {
    this.meetings.delete(id);
  }

  list(): Meeting[] {
    return Array.from(this.meetings.values());
  }
}
