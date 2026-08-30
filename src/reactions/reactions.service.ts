import { ForbiddenException, Injectable } from '@nestjs/common';
import { Meeting } from '../meeting/entities/meeting.entity';

export const ALLOWED_REACTIONS = [
  '👍',
  '👎',
  '❤️',
  '👏',
  '🎉',
  '😂',
  '😮',
  '🙌',
  '🤔',
  '💯',
] as const;
export type ReactionEmoji = (typeof ALLOWED_REACTIONS)[number];

const MAX_REACTIONS_PER_WINDOW = 5;
const WINDOW_MS = 2000;

@Injectable()
export class ReactionsService {
  /** userId -> recent reaction timestamps, for simple burst throttling. */
  private readonly recent = new Map<string, number[]>();

  validate(
    meeting: Meeting,
    userId: string,
    emoji: string,
  ): asserts emoji is ReactionEmoji {
    if (!meeting.reactionsEnabled) {
      throw new ForbiddenException('Reactions are disabled in this meeting');
    }
    if (!(ALLOWED_REACTIONS as readonly string[]).includes(emoji)) {
      throw new ForbiddenException(`Unsupported reaction: ${emoji}`);
    }

    const now = Date.now();
    const timestamps = (this.recent.get(userId) ?? []).filter(
      (t) => now - t < WINDOW_MS,
    );
    if (timestamps.length >= MAX_REACTIONS_PER_WINDOW) {
      throw new ForbiddenException('Reaction rate limit exceeded');
    }
    timestamps.push(now);
    this.recent.set(userId, timestamps);
  }

  clearUser(userId: string): void {
    this.recent.delete(userId);
  }
}
