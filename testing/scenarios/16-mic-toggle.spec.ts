import { test, expect } from '@playwright/test';
import { closePeers, setupMeeting, waitUntil } from '../lib/scenario-helpers.js';

test.describe('Scenario 16: Microphone toggle', () => {
  test('every participant: mute, unmute — state synchronizes across the room', async ({ browser }) => {
    const rig = await setupMeeting(browser, 'Host', ['Developer 1', 'Designer']); // setupMeeting already produces mic

    try {
      for (const peer of rig.all) {
        const muteAck = await peer.call<{ success: boolean }>('pauseProducer', 'mic');
        expect(muteAck.success).toBe(true);
        await waitUntil(async () => {
          const events = await rig.host.eventsOfType<{ peerId: string; forced: boolean }>('audioMuted');
          return events.some((e) => e.payload.peerId === peer.user.id && e.payload.forced === false);
        });

        const unmuteAck = await peer.call<{ success: boolean }>('resumeProducer', 'mic');
        expect(unmuteAck.success).toBe(true);
        await waitUntil(async () => {
          const events = await rig.host.eventsOfType<{ peerId: string }>('audioUnmuted');
          return events.some((e) => e.payload.peerId === peer.user.id);
        });
      }
    } finally {
      await closePeers(rig.all);
    }
  });
});
