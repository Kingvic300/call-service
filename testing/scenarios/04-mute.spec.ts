import { test, expect } from '@playwright/test';
import { closePeers, setupMeeting, waitUntil } from '../lib/scenario-helpers.js';

test.describe('Scenario 4: Host mutes Developer 2', () => {
  test('mute event received, audio stops at the mediasoup level, UI state broadcasts to everyone', async ({ browser }) => {
    const rig = await setupMeeting(browser, 'Host', ['Developer 2']);
    const dev2Peer = rig.peers['Developer 2'];
    const dev2User = dev2Peer.user;

    try {
      // Host must have actually consumed Developer 2's mic to observe the
      // pause propagate — setupMeeting's auto-consume already guarantees this.
      await waitUntil(async () => {
        const consumed = await rig.host.eventsOfType<{ mediaReceiving: boolean }>('consumed');
        return consumed.some((e) => e.payload.mediaReceiving);
      });

      const muteAck = await rig.host.call<{ success: boolean }>('muteParticipant', dev2User.id);
      expect(muteAck.success).toBe(true);

      // 1. Target receives the direct forceMuted notification.
      await waitUntil(async () => (await dev2Peer.eventsOfType('forceMuted')).length > 0);

      // 2. "audio stops" / "UI state changes" — the room-wide broadcast every
      // client's UI reacts to (mediasoup-client has no client-visible signal
      // for a remote producer being paused server-side — call-service's own
      // broadcast is the real, and only, mechanism a client has for this;
      // see the comment in browser-app/client.ts's consume()).
      await waitUntil(async () => {
        const events = await rig.host.eventsOfType<{ peerId: string; forced: boolean }>('audioMuted');
        return events.some((e) => e.payload.peerId === dev2User.id && e.payload.forced === true);
      });
    } finally {
      await closePeers(rig.all);
    }
  });
});
