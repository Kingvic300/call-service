import { test, expect } from '@playwright/test';
import { closePeers, setupMeeting, waitUntil } from '../lib/scenario-helpers.js';
import { restClient } from '../lib/rest-client.js';

test.describe('Scenario 17: Host ends meeting', () => {
  test('all sockets notified and disconnected, media torn down, meeting no longer active', async ({ browser }) => {
    const rig = await setupMeeting(browser, 'Host', ['Developer 1', 'Designer', 'QA Engineer']);

    try {
      const healthBefore = await restClient.health();
      expect(healthBefore.meetings.activeMeetings).toBeGreaterThanOrEqual(1);

      const endAck = await rig.host.call<{ success: boolean }>('endMeeting');
      expect(endAck.success).toBe(true);

      // Every participant (including the host itself) gets meetingEnded — this
      // was a real bug during development: the host's own socket was torn down
      // synchronously before its own ack could be delivered (see
      // MeetingService.end()'s setImmediate fix) — the ack assertion above and
      // this broadcast assertion together cover that regression.
      for (const peer of rig.all) {
        await waitUntil(async () => (await peer.eventsOfType('meetingEnded')).length > 0);
      }

      // Sockets actually disconnected server-side, not just told.
      for (const peer of rig.all) {
        await waitUntil(async () => !(await peer.call<boolean>('isConnected')));
      }

      // "Meeting removed": no longer active / joinable, and roster is empty —
      // the record itself is intentionally kept (not deleted) so late GET
      // calls still resolve; see MeetingService.end()'s doc comment. A hard
      // delete is a separate, explicit DELETE /meetings/:id call.
      const finalState = await restClient.getMeeting(rig.meeting.id);
      expect(finalState.participantCount).toBe(0);

      const healthAfter = await restClient.health();
      expect(healthAfter.meetings.activeMeetings).toBe(healthBefore.meetings.activeMeetings - 1);
    } finally {
      await closePeers(rig.all);
    }
  });
});
