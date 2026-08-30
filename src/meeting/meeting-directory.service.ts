import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export interface MeetingOwner {
  instanceId: string;
  internalUrl: string;
}

const OWNER_TTL_SECONDS = 24 * 60 * 60;

function ownerKey(meetingId: string): string {
  return `callservice:meeting:${meetingId}:owner`;
}

/**
 * Redis-backed, cross-instance-visible directory of *who owns* each
 * meeting's mediasoup Router — the routing metadata that lets any instance
 * find the one that actually holds a meeting's live state.
 *
 * Deliberately NOT a drop-in replacement for IMeetingRepository/
 * InMemoryMeetingRepository: a Meeting's live Participants own real
 * mediasoup Transport/Producer/Consumer objects (see participant.entity.ts)
 * that are process-bound and cannot be serialized or reconstructed on
 * another instance. The in-memory repository stays the authoritative store
 * on whichever instance owns a meeting. Every meeting-scoped REST request
 * that lands on a non-owning instance is forwarded to the owner
 * (MeetingOwnershipMiddleware) rather than answered from a local copy, so
 * this directory only needs to track ownership, not a mirrored snapshot of
 * meeting/participant state — there's nothing in Phase 1 that reads state
 * without going through the real owner.
 *
 * Every method is a safe no-op when Redis isn't configured (single-instance
 * mode) so call sites never need to branch on `redis.enabled` themselves.
 */
@Injectable()
export class MeetingDirectoryService {
  constructor(private readonly redis: RedisService) {}

  async registerOwnership(
    meetingId: string,
    owner: MeetingOwner,
  ): Promise<void> {
    if (!this.redis.client) return;
    await this.redis.client.set(
      ownerKey(meetingId),
      `${owner.instanceId}|${owner.internalUrl}`,
      'EX',
      OWNER_TTL_SECONDS,
    );
  }

  async getOwner(meetingId: string): Promise<MeetingOwner | undefined> {
    if (!this.redis.client) return undefined;
    const raw = await this.redis.client.get(ownerKey(meetingId));
    if (!raw) return undefined;
    const [instanceId, internalUrl] = raw.split('|');
    if (!instanceId || !internalUrl) return undefined;
    return { instanceId, internalUrl };
  }

  async clearOwnership(meetingId: string): Promise<void> {
    if (!this.redis.client) return;
    await this.redis.client.del(ownerKey(meetingId));
  }
}
