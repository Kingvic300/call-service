import { test, expect } from '@playwright/test';
import { closePeers, openPeer, setupMeeting, userByRole, waitUntil } from '../lib/scenario-helpers.js';

interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: string;
}

test.describe('Scenario 9: Everyone sends chat messages', () => {
  test('ordering, timestamps, delivery, and persistence for a late joiner', async ({ browser }) => {
    const rig = await setupMeeting(browser, 'Host', ['Developer 1', 'Designer'], {}, false);

    try {
      const messages = ['first message', 'second message', 'third message'];
      const senders = [rig.host, rig.peers['Developer 1'], rig.peers['Designer']];

      for (let i = 0; i < messages.length; i += 1) {
        const ack = await senders[i].call<{ success: boolean }>('sendChatMessage', messages[i]);
        expect(ack.success).toBe(true);
        await new Promise((r) => setTimeout(r, 50)); // keep sentAt strictly increasing for the ordering check
      }

      await waitUntil(async () => (await rig.host.eventsOfType<ChatMessage>('chatMessage')).length >= 3);

      // Delivery + ordering: every peer sees all 3, in send order.
      for (const peer of rig.all) {
        const received = (await peer.eventsOfType<ChatMessage>('chatMessage')).map((e) => e.payload);
        expect(received.map((m) => m.text)).toEqual(messages);
        // Timestamps: present, parseable, monotonically non-decreasing.
        const times = received.map((m) => new Date(m.sentAt).getTime());
        expect(times.every((t) => !Number.isNaN(t))).toBe(true);
        expect(times).toEqual([...times].sort((a, b) => a - b));
      }

      // Persistence: a participant joining AFTER the messages were sent still gets them.
      const lateUser = userByRole('QA Engineer');
      const latePeer = await openPeer(browser, lateUser, '/meetings');
      const joinAck = await latePeer.joinRoom(rig.meeting.id);
      expect(joinAck.success, joinAck.error).toBe(true);
      const history = (joinAck.data as unknown as { chatHistory: ChatMessage[] }).chatHistory;
      expect(history.map((m) => m.text)).toEqual(messages);

      await closePeers([latePeer]);
    } finally {
      await closePeers(rig.all);
    }
  });
});
