import { test, expect } from '@playwright/test';
import { closePeers, setupMeeting, waitUntil } from '../lib/scenario-helpers.js';
import { restClient } from '../lib/rest-client.js';

test.describe('Scenario 2: Four-person meeting', () => {
  test('Host, Developer 1, Designer, QA Engineer all join, publish, and receive video', async ({ browser }) => {
    const rig = await setupMeeting(
      browser,
      'Host',
      ['Developer 1', 'Designer', 'QA Engineer'],
      {},
      false, // produce below explicitly, camera not just mic
    );

    try {
      for (const peer of rig.all) {
        await peer.call('produceMic');
        await peer.call('produceCamera');
      }

      // Every peer should end up with 3 remote producers auto-consumed
      // (the other three participants' cameras) plus mics.
      for (const peer of rig.all) {
        await waitUntil(async () => {
          const consumed = await peer.eventsOfType<{ mediaReceiving: boolean; kind: string }>('consumed');
          const videoConsumed = consumed.filter((e) => e.payload.kind === 'video' && e.payload.mediaReceiving);
          return videoConsumed.length >= 3;
        }, 15000);
      }

      const participants = await restClient.listParticipants(rig.meeting.id);
      expect(participants).toHaveLength(4);

      // "latency acceptable" — a real, cheap proxy: outbound RTT from getStats().
      const stats = await rig.host.call<Record<string, unknown>[]>('getSendTransportStats');
      const candidatePair = stats.find((s) => s.type === 'candidate-pair' && s.state === 'succeeded') as
        | { currentRoundTripTime?: number }
        | undefined;
      if (candidatePair?.currentRoundTripTime !== undefined) {
        expect(candidatePair.currentRoundTripTime).toBeLessThan(1); // seconds; loopback should be near-zero
      }
    } finally {
      await closePeers(rig.all);
    }
  });
});
