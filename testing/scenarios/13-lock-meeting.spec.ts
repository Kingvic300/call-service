import { test, expect } from '@playwright/test';
import { closePeers, openPeer, setupMeeting, userByRole } from '../lib/scenario-helpers.js';

test.describe('Scenario 13: Host locks meeting', () => {
  test('a new participant cannot join a locked meeting', async ({ browser }) => {
    const rig = await setupMeeting(browser, 'Host', [], {}, false);

    const lockAck = await rig.host.call<{ success: boolean }>('lockMeeting');
    expect(lockAck.success).toBe(true);

    const newcomer = userByRole('Developer 3');
    const newcomerPeer = await openPeer(browser, newcomer, '/meetings');

    try {
      const joinAck = await newcomerPeer.joinRoom(rig.meeting.id);
      expect(joinAck.success).toBe(false);
      expect(joinAck.error).toMatch(/locked/i);

      const unlockAck = await rig.host.call<{ success: boolean }>('unlockMeeting');
      expect(unlockAck.success).toBe(true);

      const joinAfterUnlock = await newcomerPeer.joinRoom(rig.meeting.id);
      expect(joinAfterUnlock.success, joinAfterUnlock.error).toBe(true);
    } finally {
      await closePeers([...rig.all, newcomerPeer]);
    }
  });
});
