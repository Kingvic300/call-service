/**
 * Thrown by SignalingService.joinRoom when a socket lands on an instance
 * that isn't the meeting's registered owner (see MeetingDirectoryService) —
 * a raw WebRTC signaling session can't be transparently forwarded to
 * another process the way a REST call can, so the client has to reconnect
 * its socket to `redirectUrl` itself. respond() (ws-response.util.ts)
 * special-cases this into a distinct ack error code instead of the generic
 * error-message string every other thrown error gets.
 */
export class WrongInstanceError extends Error {
  constructor(readonly redirectUrl: string) {
    super('WRONG_INSTANCE');
    this.name = 'WrongInstanceError';
  }
}
