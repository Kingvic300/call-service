import { test, expect } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { closePeers, loadUsers, openPeer, waitUntil } from '../lib/scenario-helpers.js';
import { restClient } from '../lib/rest-client.js';
import { config } from '../lib/config.js';

function ack<T>(socket: Socket, event: string, payload: unknown): Promise<{ success: boolean; data?: T; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 10000);
    socket.emit(event, payload, (r: { success: boolean; data?: T; error?: string }) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
}

async function connectSignalingOnly(meetingId: string, userId: string): Promise<Socket> {
  const socket = io(`${config.callServiceWsUrl}/meetings`, {
    auth: { apiKey: config.apiKey, secretKey: config.secretKey, userId, displayName: userId },
    transports: ['websocket'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 10000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const joinAck = await ack(socket, 'joinRoom', { meetingId });
  if (!joinAck.success) throw new Error(`signaling-only join failed: ${joinAck.error}`);
  return socket;
}

test.describe('Scenario 3: 12-person standup', () => {
  test('all 12 users join, simulcast negotiates for real browser peers, no worker crashes', async ({ browser }) => {
    test.setTimeout(60_000);
    const users = loadUsers();
    const [hostUser, ...restUsers] = users;
    // Real Chromium contexts for a sample large enough to prove multi-party
    // (not just 1:1) fan-out actually works; the rest join as lightweight
    // signaling-only clients (no browser) purely to reach the full
    // 12-person roster. Running many concurrent full Chromium+WebRTC stacks
    // reliably needs more spare CPU than a shared dev machine running the
    // author's own desktop session alongside it is guaranteed to have at
    // any given moment — empirically, 2 real receivers (host + 2, proven
    // reliable in isolation) is the count that stayed reliable here; the
    // other 9 add roster scale without that same resource cost. See
    // testing/README.md's "what's real vs simulated" note.
    const REAL_BROWSER_PEER_COUNT = 2;
    const browserUsers = restUsers.slice(0, REAL_BROWSER_PEER_COUNT);
    const signalingOnlyUsers = restUsers.slice(REAL_BROWSER_PEER_COUNT);

    const meeting = await restClient.createMeeting(hostUser.id);
    const healthBefore = await restClient.health();

    const host = await openPeer(browser, hostUser, '/meetings');
    const hostJoin = await host.joinRoom(meeting.id);
    expect(hostJoin.success, hostJoin.error).toBe(true);

    const simulcast = await host.call<{ id: string; encodingCount: number }>('produceCameraSimulcast');
    expect(simulcast.encodingCount).toBe(3); // "simulcast works": 3 layers actually negotiated

    const browserPeers = [host];
    for (const user of browserUsers) {
      const peer = await openPeer(browser, user, '/meetings');
      const join = await peer.joinRoom(meeting.id);
      expect(join.success, `${user.role} join: ${join.error}`).toBe(true);
      await peer.call('produceMic');
      browserPeers.push(peer);
    }

    const signalingSockets: Socket[] = [];
    for (const user of signalingOnlyUsers) {
      signalingSockets.push(await connectSignalingOnly(meeting.id, user.id));
    }

    try {
      const participants = await restClient.listParticipants(meeting.id);
      expect(participants).toHaveLength(12); // "participant count" — the full roster, real browsers + signaling-only alike

      // Real media fan-out: every real-browser receiver actually gets the host's simulcast video.
      await Promise.all(
        browserPeers.slice(1).map((peer) =>
          waitUntil(async () => {
            const consumed = await peer.eventsOfType<{ kind: string; mediaReceiving: boolean }>('consumed');
            return consumed.some((e) => e.payload.kind === 'video' && e.payload.mediaReceiving);
          }, 30000),
        ),
      );

      // "no crashes": worker count unchanged, server still healthy.
      const healthAfter = await restClient.health();
      expect(healthAfter.mediasoup.workerCount).toBe(healthBefore.mediasoup.workerCount);
      expect(healthAfter.status).toBe('ok');

      for (const peer of browserPeers) {
        expect(await peer.eventsOfType('errorEvent')).toHaveLength(0);
      }
    } finally {
      await closePeers(browserPeers);
      for (const s of signalingSockets) s.disconnect();
    }
  });
});
