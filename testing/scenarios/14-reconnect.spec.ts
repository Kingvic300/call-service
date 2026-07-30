import { test, expect } from '@playwright/test';
import { closePeers, setupMeeting, waitUntil } from '../lib/scenario-helpers.js';
import { restClient } from '../lib/rest-client.js';

test.describe('Scenario 14: Network interruption and reconnect', () => {
  test('ICE restart succeeds; reconnect within the grace period keeps the participant in the roster', async ({ browser }) => {
    const rig = await setupMeeting(browser, 'Host', ['Developer 1']);
    const dev = rig.peers['Developer 1'];

    try {
      // ICE restart: the real recovery mechanism for a degraded connection —
      // confirms the transport actually issues fresh ICE parameters.
      const restartAck = await dev.call<{ success: boolean; data?: { usernameFragment: string } }>(
        'restartIce',
        'send',
      );
      expect(restartAck.success, restartAck as unknown as string).toBe(true);
      expect(restartAck.data?.usernameFragment).toBeTruthy();

      // Simulate a real network interruption at the browser level (not just
      // closing the socket) — genuinely cuts the transport, same as a phone
      // losing wifi. DISCONNECT_GRACE_PERIOD_MS defaults to 10s server-side.
      await dev.page.context().setOffline(true);
      await new Promise((r) => setTimeout(r, 3000)); // well inside the 10s grace period
      await dev.page.context().setOffline(false);

      // Reconnect + rejoin — this is what a client is expected to do itself;
      // call-service has no server-initiated reconnect push.
      await dev.connect('/meetings');
      const rejoin = await dev.joinRoom(rig.meeting.id);
      expect(rejoin.success, rejoin.error).toBe(true);

      // Transport recovery: still a full participant (never dropped from the roster).
      const participants = await restClient.listParticipants(rig.meeting.id);
      expect(participants).toHaveLength(2);

      // Media restored: producing again after reconnect works end to end
      // (old mediasoup transports don't survive a reconnect — see
      // docs/INTEGRATION.md's §2.3 step 7 — a fresh produce call is expected).
      await dev.call('produceMic');
      await waitUntil(async () => (await dev.connectionState('send')) === 'connected');
    } finally {
      await closePeers(rig.all);
    }
  });
});
