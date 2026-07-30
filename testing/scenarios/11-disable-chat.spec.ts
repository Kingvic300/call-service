import { test, expect } from '@playwright/test';
import { closePeers, setupMeeting, waitUntil } from '../lib/scenario-helpers.js';

test.describe('Scenario 11: Host disables chat', () => {
  test('new messages rejected, existing history remains intact', async ({ browser }) => {
    const rig = await setupMeeting(browser, 'Host', ['Developer 1'], {}, false);
    const dev = rig.peers['Developer 1'];

    try {
      const beforeAck = await dev.call<{ success: boolean }>('sendChatMessage', 'before disabling');
      expect(beforeAck.success).toBe(true);
      await waitUntil(async () => (await rig.host.eventsOfType('chatMessage')).length >= 1);

      const disableAck = await rig.host.call<{ success: boolean }>('disableFeature', 'chat', false);
      expect(disableAck.success).toBe(true);
      await waitUntil(async () => {
        const events = await dev.eventsOfType<{ chatEnabled: boolean }>('meetingStateUpdated');
        return events.some((e) => e.payload.chatEnabled === false);
      });

      const afterAck = await dev.call<{ success: boolean; error?: string }>('sendChatMessage', 'after disabling');
      expect(afterAck.success).toBe(false);

      // Existing message untouched — still exactly one delivered.
      const received = await rig.host.eventsOfType('chatMessage');
      expect(received).toHaveLength(1);
    } finally {
      await closePeers(rig.all);
    }
  });
});
