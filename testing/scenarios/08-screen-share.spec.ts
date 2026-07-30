import { test, expect } from '@playwright/test';
import { closePeers, setupMeeting, waitUntil } from '../lib/scenario-helpers.js';

test.describe('Scenario 8: Designer shares screen', () => {
  test('presenter reserved, everyone receives the presentation, cleanup on stop', async ({ browser }) => {
    const rig = await setupMeeting(browser, 'Host', ['Designer', 'QA Engineer'], {}, false);
    const designer = rig.peers['Designer'];

    try {
      const reserveAck = await designer.call<{ success: boolean }>('startScreenShareReservation');
      expect(reserveAck.success).toBe(true);

      // (canvas-captured stream — see browser-app/client.ts's produceScreenShare doc comment)
      const producerId = await designer.call<string>('produceScreenShare');
      expect(producerId).toBeTruthy();

      await waitUntil(async () => {
        const events = await rig.host.eventsOfType<{ peerId: string }>('screenShareStarted');
        return events.some((e) => e.payload.peerId === designer.user.id);
      });

      // Everyone else actually receives the presentation stream.
      for (const peer of [rig.host, rig.peers['QA Engineer']]) {
        await waitUntil(async () => {
          const consumed = await peer.eventsOfType<{ mediaReceiving: boolean; kind: string }>('consumed');
          return consumed.some((e) => e.payload.kind === 'video' && e.payload.mediaReceiving);
        }, 15000);
      }

      // Single-presenter enforcement: a second participant trying to share is rejected.
      const secondReserveAck = await rig.host.call<{ success: boolean }>('startScreenShareReservation');
      expect(secondReserveAck.success).toBe(false);

      const stopAck = await designer.call<{ success: boolean }>('stopScreenShare');
      expect(stopAck.success).toBe(true);

      await waitUntil(async () => {
        const events = await rig.host.eventsOfType<{ peerId: string }>('screenShareStopped');
        return events.some((e) => e.payload.peerId === designer.user.id);
      });

      // Cleanup: presenter slot freed — someone else can now share.
      const thirdReserveAck = await rig.host.call<{ success: boolean }>('startScreenShareReservation');
      expect(thirdReserveAck.success).toBe(true);
    } finally {
      await closePeers(rig.all);
    }
  });
});
