import { ParticipantRole } from './role.enum';

export enum Permission {
  MUTE_OTHERS = 'mute_others',
  REQUEST_UNMUTE = 'request_unmute',
  REMOVE_PARTICIPANT = 'remove_participant',
  LOCK_MEETING = 'lock_meeting',
  END_MEETING = 'end_meeting',
  DISABLE_SCREEN_SHARE = 'disable_screen_share',
  DISABLE_CHAT = 'disable_chat',
  DISABLE_REACTIONS = 'disable_reactions',
  PROMOTE_MODERATOR = 'promote_moderator',
  DEMOTE_MODERATOR = 'demote_moderator',
  MANAGE_WAITING_ROOM = 'manage_waiting_room',
  START_SCREEN_SHARE = 'start_screen_share',
  LOWER_HAND = 'lower_hand',
  INVITE_TO_SPEAK = 'invite_to_speak',
}

/**
 * Default role -> permission matrix. Callers may override per-meeting via
 * Meeting.permissionOverrides (see meeting.entity.ts) to support the spec's
 * "permissions must be configurable" requirement without hardcoding a single
 * global policy.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<
  ParticipantRole,
  ReadonlySet<Permission>
> = {
  [ParticipantRole.HOST]: new Set(Object.values(Permission)),
  [ParticipantRole.MODERATOR]: new Set([
    Permission.MUTE_OTHERS,
    Permission.REQUEST_UNMUTE,
    Permission.REMOVE_PARTICIPANT,
    Permission.DISABLE_SCREEN_SHARE,
    Permission.DISABLE_CHAT,
    Permission.DISABLE_REACTIONS,
    Permission.MANAGE_WAITING_ROOM,
    Permission.START_SCREEN_SHARE,
    Permission.LOWER_HAND,
    Permission.INVITE_TO_SPEAK,
  ]),
  [ParticipantRole.PARTICIPANT]: new Set([Permission.START_SCREEN_SHARE]),
};
