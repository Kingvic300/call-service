import { config } from './config.js';

/** Thin wrapper around call-service's backend REST API (native fetch — no axios needed for four calls). */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.callServiceUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': config.apiKey,
      'X-Secret-Key': config.secretKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json as T;
}

export interface MeetingState {
  id: string;
  type: 'one_to_one' | 'group';
  mode: 'audio_only' | 'video';
  locked: boolean;
  chatEnabled: boolean;
  reactionsEnabled: boolean;
  screenShareEnabled: boolean;
  waitingRoomEnabled: boolean;
  activePresenterId: string | null;
  participantCount: number;
}

export const restClient = {
  createCall: (callerId: string) => request<MeetingState>('POST', '/calls', { callerId }),
  getCall: (id: string) => request<MeetingState>('GET', `/calls/${id}`),
  endCall: (id: string) => request<MeetingState>('POST', `/calls/${id}/end`),

  createMeeting: (hostId: string, opts: Partial<{
    waitingRoomEnabled: boolean;
    chatEnabled: boolean;
    reactionsEnabled: boolean;
    screenShareEnabled: boolean;
  }> = {}) => request<MeetingState>('POST', '/meetings', { hostId, ...opts }),
  getMeeting: (id: string) => request<MeetingState>('GET', `/meetings/${id}`),
  endMeeting: (id: string) => request<MeetingState>('POST', `/meetings/${id}/end`),
  deleteMeeting: (id: string) => request<{ deleted: true }>('DELETE', `/meetings/${id}`),

  listParticipants: (meetingId: string) => request<unknown[]>('GET', `/participants/${meetingId}`),

  health: () => request<{
    status: string;
    mediasoup: { workerCount: number; workers: Array<{ pid: number; routerCount: number }> };
    meetings: { totalMeetings: number; activeMeetings: number; totalParticipants: number };
  }>('GET', '/health'),
};
