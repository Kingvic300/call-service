export enum ParticipantRole {
  HOST = 'host',
  MODERATOR = 'moderator',
  PARTICIPANT = 'participant',
}

/**
 * Ranking used for permission comparisons (e.g. "can X moderate Y").
 * Higher number = more privileged.
 */
export const ROLE_RANK: Record<ParticipantRole, number> = {
  [ParticipantRole.PARTICIPANT]: 0,
  [ParticipantRole.MODERATOR]: 1,
  [ParticipantRole.HOST]: 2,
};
