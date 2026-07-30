export enum MeetingType {
  /** 1:1 audio/video call — served by the lightweight /calls namespace. */
  ONE_TO_ONE = 'one_to_one',
  /** Group call or large standup meeting — served by the full-featured /meetings namespace. */
  GROUP = 'group',
}

export enum MeetingMode {
  AUDIO_ONLY = 'audio_only',
  VIDEO = 'video',
}
