import { Injectable } from '@nestjs/common';
import { Namespace } from 'socket.io';

export function meetingRoomName(meetingId: string): string {
  return `meeting:${meetingId}`;
}

/**
 * Thin wrapper around the live Socket.IO namespaces so non-gateway services
 * (ModerationService, MeetingService, ChatService, ...) can push events to
 * connected clients without importing CallsGateway/MeetingsGateway directly
 * — avoids a circular dependency between the websocket layer and every
 * domain module that needs to trigger a broadcast (e.g. a host REST call to
 * POST /meetings/:id/kick has to reach a live socket).
 *
 * Namespace-aware because /calls (1:1) and /meetings (group) are two
 * separate Socket.IO namespaces with independent socket-id spaces — callers
 * pass `meeting.namespace` (set once at creation, see Meeting entity) so
 * this class never has to guess which one a meeting belongs to.
 */
@Injectable()
export class RealtimeBroadcaster {
  private readonly namespaces = new Map<string, Namespace>();

  registerNamespace(name: string, nsp: Namespace): void {
    this.namespaces.set(name, nsp);
  }

  emitToMeeting(
    namespace: string,
    meetingId: string,
    event: string,
    payload: unknown,
  ): void {
    this.namespaces
      .get(namespace)
      ?.to(meetingRoomName(meetingId))
      .emit(event, payload);
  }

  emitToMeetingExcept(
    namespace: string,
    meetingId: string,
    exceptSocketId: string,
    event: string,
    payload: unknown,
  ): void {
    this.namespaces
      .get(namespace)
      ?.to(meetingRoomName(meetingId))
      .except(exceptSocketId)
      .emit(event, payload);
  }

  emitToSocket(
    namespace: string,
    socketId: string,
    event: string,
    payload: unknown,
  ): void {
    this.namespaces.get(namespace)?.to(socketId).emit(event, payload);
  }

  /**
   * Every socket auto-joins a room equal to its own id, so `.in(socketId)`
   * reaches it through the Socket.IO Redis adapter (when configured) even
   * if it's connected to a different instance — a plain local
   * `nsp.sockets.get(socketId)` lookup, used here previously, only ever
   * saw sockets connected to *this* process and silently no-op'd for any
   * other instance's participant once multi-instance mode landed.
   */
  disconnectSocket(namespace: string, socketId: string, reason?: string): void {
    const nsp = this.namespaces.get(namespace);
    if (!nsp) return;
    if (reason) nsp.to(socketId).emit('errorEvent', { message: reason });
    nsp.in(socketId).disconnectSockets(true);
  }
}
