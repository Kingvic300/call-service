import { test, expect } from '@playwright/test';
import { closePeers, openPeer, userByRole, waitUntil } from '../lib/scenario-helpers.js';
import { restClient } from '../lib/rest-client.js';

test.describe('Scenario 1: One-on-one call', () => {
  test('host calls Developer 1 — audio connects, ICE connects, both receive media, clean disconnect', async ({ browser }) => {
    const host = userByRole('Host');
    const dev1 = userByRole('Developer 1');

    const call = await restClient.createCall(host.id);
    expect(call.type).toBe('one_to_one');

    const hostPeer = await openPeer(browser, host, '/calls');
    const devPeer = await openPeer(browser, dev1, '/calls');

    try {
      const hostJoin = await hostPeer.joinRoom(call.id);
      expect(hostJoin.success, hostJoin.error).toBe(true);
      const devJoin = await devPeer.joinRoom(call.id);
      expect(devJoin.success, devJoin.error).toBe(true);

      await hostPeer.call('produceMic');
      await devPeer.call('produceMic');

      // Real ICE connection state, from mediasoup-client's actual RTCPeerConnection.
      await waitUntil(async () => (await hostPeer.connectionState('send')) === 'connected');
      await waitUntil(async () => (await devPeer.connectionState('send')) === 'connected');

      // Each side auto-consumes the other's mic producer on the `newProducer`
      // broadcast (see browser-app/client.ts) — wait for both to report real
      // media received (a hidden <audio> element actually getting frames).
      await waitUntil(async () => {
        const consumed = await hostPeer.eventsOfType<{ mediaReceiving: boolean }>('consumed');
        return consumed.some((e) => e.payload.mediaReceiving);
      });
      await waitUntil(async () => {
        const consumed = await devPeer.eventsOfType<{ mediaReceiving: boolean }>('consumed');
        return consumed.some((e) => e.payload.mediaReceiving);
      });

      const endAck = await hostPeer.call<{ success: boolean }>('endMeeting');
      expect(endAck.success).toBe(true);

      await waitUntil(async () => (await devPeer.eventsOfType('meetingEnded')).length > 0);

      const finalState = await restClient.getCall(call.id);
      expect(finalState.participantCount).toBe(0);
    } finally {
      await closePeers([hostPeer, devPeer]);
    }
  });
});
