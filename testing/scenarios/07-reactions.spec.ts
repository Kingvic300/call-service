import { test, expect } from '@playwright/test';
import { closePeers, setupMeeting, waitUntil } from '../lib/scenario-helpers.js';

const REACTIONS = ['👍', '❤️', '👏', '🎉', '😂', '😮'];

test.describe('Scenario 7: Everyone sends reactions', () => {
  test('reactions broadcast to the room; disallowed emoji rejected', async ({ browser }) => {
    const rig = await setupMeeting(browser, 'Host', ['Developer 1', 'Designer']);

    try {
      // "disappear automatically" is a client-UI concern (see ReactionsService
      // — the server broadcasts once, it doesn't track/expire anything) —
      // there's no server-side state to assert here beyond the broadcast
      // itself, which every real client's UI timeout is driven by.
      let i = 0;
      for (const emoji of REACTIONS) {
        const sender = rig.all[i % rig.all.length];
        const ack = await sender.call<{ success: boolean }>('sendReaction', emoji);
        expect(ack.success, `${emoji} from ${sender.user.role}`).toBe(true);

        await waitUntil(async () => {
          const events = await rig.host.eventsOfType<{ emoji: string; peerId: string }>('reaction');
          return events.some((e) => e.payload.emoji === emoji && e.payload.peerId === sender.user.id);
        });

        i += 1;
        // Stay under ReactionsService's 5-per-2s per-user throttle while still exercising every emoji quickly.
        await new Promise((r) => setTimeout(r, 350));
      }

      const badAck = await rig.host.call<{ success: boolean; error?: string }>('sendReaction', '💀');
      expect(badAck.success).toBe(false);
    } finally {
      await closePeers(rig.all);
    }
  });
});
