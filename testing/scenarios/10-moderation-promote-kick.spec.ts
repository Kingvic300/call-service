import { test, expect } from '@playwright/test';
import { closePeers, setupMeeting, waitUntil } from '../lib/scenario-helpers.js';

test.describe('Scenario 10: Host promotes QA to Moderator, Moderator kicks Intern', () => {
  test('promotion grants real moderator permission; a plain participant cannot do the same', async ({ browser }) => {
    const rig = await setupMeeting(browser, 'Host', ['QA Engineer', 'Intern', 'Observer']);
    const qa = rig.peers['QA Engineer'];
    const intern = rig.peers['Intern'];
    const observer = rig.peers['Observer'];

    try {
      // Before promotion: QA has no kick permission.
      const forbiddenKick = await qa.call<{ success: boolean; error?: string }>('kickParticipant', intern.user.id);
      expect(forbiddenKick.success).toBe(false);

      const promoteAck = await rig.host.call<{ success: boolean }>('promoteModerator', qa.user.id);
      expect(promoteAck.success).toBe(true);

      await waitUntil(async () => {
        const events = await qa.eventsOfType<{ peerId: string; role: string }>('participantRoleChanged');
        return events.some((e) => e.payload.peerId === qa.user.id && e.payload.role === 'moderator');
      });

      // After promotion: QA (now moderator) really can kick.
      const kickAck = await qa.call<{ success: boolean }>('kickParticipant', intern.user.id);
      expect(kickAck.success).toBe(true);

      await waitUntil(async () => {
        const events = await rig.host.eventsOfType<{ peerId: string }>('participantRemoved');
        return events.some((e) => e.payload.peerId === intern.user.id);
      });

      // A never-promoted plain participant (Observer) still cannot.
      const stillForbidden = await observer.call<{ success: boolean; error?: string }>(
        'kickParticipant',
        qa.user.id,
      );
      expect(stillForbidden.success).toBe(false);
    } finally {
      await closePeers(rig.all);
    }
  });
});
