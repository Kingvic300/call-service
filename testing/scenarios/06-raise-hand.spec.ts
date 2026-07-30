import { test, expect } from '@playwright/test';
import { closePeers, setupMeeting, waitUntil } from '../lib/scenario-helpers.js';

test.describe('Scenario 6: Developer raises hand', () => {
  test('host is notified, host can lower the raised hand', async ({ browser }) => {
    const rig = await setupMeeting(browser, 'Host', ['Developer 1']);
    const dev = rig.peers['Developer 1'];

    try {
      const raiseAck = await dev.call<{ success: boolean }>('raiseHand');
      expect(raiseAck.success).toBe(true);

      await waitUntil(async () => {
        const events = await rig.host.eventsOfType<{ peerId: string }>('handRaised');
        return events.some((e) => e.payload.peerId === dev.user.id);
      });

      // Host-moderation lower (distinct from self-lower) — was dead code in
      // ModerationService until wired to this event during this test suite's
      // development; see meetings.gateway.ts's onLowerParticipantHand.
      const lowerAck = await rig.host.call<{ success: boolean }>('emitEvent', 'lowerParticipantHand', {
        targetUserId: dev.user.id,
      });
      expect(lowerAck.success, JSON.stringify(lowerAck)).toBe(true);

      await waitUntil(async () => {
        const events = await dev.eventsOfType<{ peerId: string }>('handLowered');
        return events.some((e) => e.payload.peerId === dev.user.id);
      });
    } finally {
      await closePeers(rig.all);
    }
  });
});
