import { test, expect } from '@playwright/test';
import { closePeers, setupMeeting, waitUntil } from '../lib/scenario-helpers.js';

test.describe('Scenario 12: Host disables reactions', () => {
  test('no reactions can be sent while disabled', async ({ browser }) => {
    const rig = await setupMeeting(browser, 'Host', ['Developer 1'], {}, false);
    const dev = rig.peers['Developer 1'];

    try {
      const disableAck = await rig.host.call<{ success: boolean }>('disableFeature', 'reactions', false);
      expect(disableAck.success).toBe(true);
      await waitUntil(async () => {
        const events = await dev.eventsOfType<{ reactionsEnabled: boolean }>('meetingStateUpdated');
        return events.some((e) => e.payload.reactionsEnabled === false);
      });

      const reactionAck = await dev.call<{ success: boolean; error?: string }>('sendReaction', '👍');
      expect(reactionAck.success).toBe(false);

      const reEnableAck = await rig.host.call<{ success: boolean }>('disableFeature', 'reactions', true);
      expect(reEnableAck.success).toBe(true);
      const worksNowAck = await dev.call<{ success: boolean }>('sendReaction', '👍');
      expect(worksNowAck.success).toBe(true);
    } finally {
      await closePeers(rig.all);
    }
  });
});
