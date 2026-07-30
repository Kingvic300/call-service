import { test, expect } from '@playwright/test';
import { closePeers, setupMeeting, waitUntil } from '../lib/scenario-helpers.js';
import { restClient } from '../lib/rest-client.js';

test.describe('Scenario 5: Host removes Observer', () => {
  test('participant removed, socket disconnected, media cleaned up', async ({ browser }) => {
    const rig = await setupMeeting(browser, 'Host', ['Observer']);
    const observer = rig.peers['Observer'];

    try {
      const kickAck = await rig.host.call<{ success: boolean }>('kickParticipant', observer.user.id);
      expect(kickAck.success).toBe(true);

      // Room-wide broadcast.
      await waitUntil(async () => {
        const events = await rig.host.eventsOfType<{ peerId: string }>('participantRemoved');
        return events.some((e) => e.payload.peerId === observer.user.id);
      });

      // Socket actually disconnected server-side, not just told to leave.
      await waitUntil(async () => !(await observer.call<boolean>('isConnected')));

      // Roster + media cleaned up server-side.
      const participants = await restClient.listParticipants(rig.meeting.id);
      expect(participants).toHaveLength(1); // host only
      expect((participants as Array<{ userId: string }>).some((p) => p.userId === observer.user.id)).toBe(false);
    } finally {
      await closePeers(rig.all); // observer's socket is already gone server-side; still close its browser context
    }
  });
});
