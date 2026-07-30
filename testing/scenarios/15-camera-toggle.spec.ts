import { test, expect } from '@playwright/test';
import { closePeers, setupMeeting, waitUntil } from '../lib/scenario-helpers.js';

test.describe('Scenario 15: Camera toggle', () => {
  test('every participant: enable, disable, enable — broadcasts correctly each time', async ({ browser }) => {
    const rig = await setupMeeting(browser, 'Host', ['Developer 1', 'Designer'], {}, false);

    try {
      for (const peer of rig.all) {
        await peer.call('produceCamera');
        await waitUntil(async () => (await peer.eventsOfType('videoEnabled')).length > 0);
      }

      for (const peer of rig.all) {
        const pauseAck = await peer.call<{ success: boolean }>('pauseProducer', 'camera');
        expect(pauseAck.success).toBe(true);
        await waitUntil(async () => {
          const events = await peer.eventsOfType<{ peerId: string }>('videoDisabled');
          return events.some((e) => e.payload.peerId === peer.user.id);
        });

        const resumeAck = await peer.call<{ success: boolean }>('resumeProducer', 'camera');
        expect(resumeAck.success).toBe(true);
        await waitUntil(async () => {
          const events = await peer.eventsOfType<{ peerId: string }>('videoEnabled');
          return events.filter((e) => e.payload.peerId === peer.user.id).length >= 2; // initial produce + this resume
        });
      }
    } finally {
      await closePeers(rig.all);
    }
  });
});
