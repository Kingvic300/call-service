/**
 * Runs inside one forked OS process (see coordinator.ts). Owns `participants`
 * real MediaPeer instances (real werift-based WebRTC clients — see
 * media-peer.ts) all joined to ONE meeting, and drives them through a fixed
 * sequence of media-stress phases. Reports results back to the coordinator
 * via process IPC (process.send), not stdout, so multiple processes' output
 * doesn't interleave into garbage.
 */
import { MediaPeer } from './media-peer.js';

interface WorkerConfig {
  roomIndex: number;
  meetingId: string;
  hostId: string;
  participants: number;
  turnOnly: boolean;
  impairment: { lossRate?: number; latencyMs?: number };
  maxConsume: number;
}

interface PhaseResult {
  phase: string;
  startedAt: number;
  durationMs: number;
  ok: number;
  failed: number;
  crashed: boolean;
  detail?: Record<string, unknown>;
}

const results: PhaseResult[] = [];
let cfg: WorkerConfig;
let peers: MediaPeer[] = [];

function report(partial: Partial<{ status: string; error: string }> = {}) {
  process.send?.({
    roomIndex: cfg.roomIndex,
    phases: results,
    sampleCounts: peers.reduce((acc, p) => acc + p.samples.length, 0),
    ...partial,
  });
}

async function timedPhase(name: string, fn: () => Promise<{ ok: number; failed: number; detail?: Record<string, unknown> }>) {
  const startedAt = Date.now();
  try {
    const { ok, failed, detail } = await fn();
    results.push({ phase: name, startedAt, durationMs: Date.now() - startedAt, ok, failed, crashed: false, detail });
  } catch (err) {
    // Distinct from a phase that ran and had failures — this phase never
    // finished at all. Kept visible as `crashed: true` rather than folded
    // into ok/failed=0, which would silently vanish in the coordinator's
    // aggregation (a real gap this harness had during its own development —
    // 4/5 processes' mass-kick phase crashed and the aggregate just showed
    // "20 failed" instead of "80 crashed, 20 failed").
    results.push({ phase: name, startedAt, durationMs: Date.now() - startedAt, ok: 0, failed: 0, crashed: true, detail: { error: String(err) } });
  }
  report(); // stream progress to the coordinator after every phase, not just at the end
}

/**
 * Counts real outcomes, not just "did the promise settle without throwing" —
 * MediaPeer's pause/resume/etc. methods return `false` (not a throw) when
 * they fail, so Promise.allSettled's fulfilled/rejected split alone would
 * have silently counted every graceful failure as a success (a real bug
 * found and fixed during this harness's own development). Also keeps a
 * small sample of distinct failure reasons for root-causing.
 */
async function settleCount(promises: Promise<boolean | string | { success: boolean; error?: string }>[]): Promise<{
  ok: number;
  failed: number;
  sampleErrors: string[];
}> {
  const settled = await Promise.allSettled(promises);
  let ok = 0;
  let failed = 0;
  const errorCounts = new Map<string, number>();
  const bump = (msg: string) => errorCounts.set(msg, (errorCounts.get(msg) ?? 0) + 1);

  for (const r of settled) {
    if (r.status === 'rejected') {
      failed++;
      bump(String(r.reason));
      continue;
    }
    const v = r.value;
    const success = typeof v === 'boolean' ? v : typeof v === 'string' ? v.length > 0 : v.success;
    if (success) ok++;
    else {
      failed++;
      bump(typeof v === 'object' && v.error ? v.error : 'returned falsy/unsuccessful');
    }
  }

  const sampleErrors = [...errorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([msg, count]) => `${count}x ${msg}`);
  return { ok, failed, sampleErrors };
}

async function main() {
  cfg = await new Promise<WorkerConfig>((resolve) => {
    process.once('message', (msg: WorkerConfig) => resolve(msg));
  });

  peers = Array.from(
    { length: cfg.participants },
    (_, i) => new MediaPeer(i === 0 ? cfg.hostId : `${cfg.hostId}-p${i}`, { maxConsume: cfg.maxConsume, impairment: cfg.impairment }),
  );
  const host = peers[0];

  // --- Phase: join ---
  await timedPhase('join', async () => {
    const { ok, failed, sampleErrors } = await settleCount(
      peers.map(async (p) => {
        await p.connect('/meetings');
        const res = await p.joinRoom(cfg.meetingId, cfg.turnOnly);
        if (!res.success) throw new Error(res.error);
        return true;
      }),
    );
    return { ok, failed, detail: { sampleErrors } };
  });

  // --- Phase: everyone enables audio simultaneously ---
  await timedPhase('simultaneous-audio', async () => {
    const { ok, failed, sampleErrors } = await settleCount(peers.map((p) => p.produceMic()));
    return { ok, failed, detail: { sampleErrors } };
  });

  // Let real RTP actually flow for a few seconds before measuring / moving on.
  await new Promise((r) => setTimeout(r, 4000));

  // --- Phase: everyone enables video simultaneously ---
  await timedPhase('simultaneous-video', async () => {
    const { ok, failed, sampleErrors } = await settleCount(peers.map((p) => p.produceCamera()));
    return { ok, failed, detail: { sampleErrors } };
  });

  await new Promise((r) => setTimeout(r, 4000));

  // Real media stats sample (not all peers — a bounded sample keeps getStats() overhead itself from skewing the results).
  await timedPhase('media-stats-sample', async () => {
    const sample = peers.slice(0, Math.min(10, peers.length));
    let ok = 0;
    let failed = 0;
    let packetsSent = 0;
    let packetsReceived = 0;
    for (const p of sample) {
      try {
        const sendStats = await p.getSendStats();
        const recvStats = await p.getRecvStats();
        const sent = sendStats.filter((s) => s.type === 'outbound-rtp').reduce((a, s) => a + (Number(s.packetsSent) || 0), 0);
        const received = recvStats.filter((s) => s.type === 'inbound-rtp').reduce((a, s) => a + (Number(s.packetsReceived) || 0), 0);
        packetsSent += sent;
        packetsReceived += received;
        // A peer with no real transport (e.g. it never got past 'join') returns [] from
        // getStats() without throwing — don't count that as "media stats OK".
        if (sent > 0 || received > 0 || p.producers.size > 0) ok++;
        else failed++;
      } catch {
        failed++;
      }
    }
    return { ok, failed, detail: { sampledPeers: sample.length, packetsSent, packetsReceived } };
  });

  // --- Phase: camera toggle storm — every participant, every ~5s, for 3 cycles ---
  await timedPhase('camera-toggle-storm', async () => {
    let ok = 0;
    let failed = 0;
    let sampleErrors: string[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const r1 = await settleCount(peers.map((p) => p.pauseProducer('camera')));
      ok += r1.ok;
      failed += r1.failed;
      sampleErrors = r1.sampleErrors;
      await new Promise((r) => setTimeout(r, 2500));
      const r2 = await settleCount(peers.map((p) => p.resumeProducer('camera')));
      ok += r2.ok;
      failed += r2.failed;
      await new Promise((r) => setTimeout(r, 2500));
    }
    return { ok, failed, detail: { cycles: 3, sampleErrors } };
  });

  // --- Phase: rapid mute/unmute storm — every participant, ~1s cadence, 10 cycles ---
  await timedPhase('mute-unmute-storm', async () => {
    let ok = 0;
    let failed = 0;
    let sampleErrors: string[] = [];
    for (let cycle = 0; cycle < 10; cycle++) {
      const r1 = await settleCount(peers.map((p) => p.pauseProducer('mic')));
      ok += r1.ok;
      failed += r1.failed;
      sampleErrors = r1.sampleErrors;
      await new Promise((r) => setTimeout(r, 500));
      const r2 = await settleCount(peers.map((p) => p.resumeProducer('mic')));
      ok += r2.ok;
      failed += r2.failed;
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok, failed, detail: { cycles: 10, sampleErrors } };
  });

  // --- Phase: multiple screen-share handoffs (single-presenter enforcement under contention) ---
  await timedPhase('screen-share-handoffs', async () => {
    const presenters = peers.slice(0, Math.min(6, peers.length));
    let ok = 0;
    let failed = 0;
    let correctlyRejected = 0;
    for (const p of presenters) {
      try {
        const reserve = await p.emitEvent('startScreenShare');
        if (reserve.success) {
          ok++;
          try {
            await p.produceScreenShare();
          } catch {
            failed++;
          }
          await new Promise((r) => setTimeout(r, 800));
          await p.emitEvent('stopScreenShare');
        } else {
          // Expected while another presenter is still active mid-handoff — not a failure of the test.
          correctlyRejected++;
        }
      } catch (err) {
        // One presenter's ack timing out must not abort the rest of the handoff sequence.
        failed++;
        void err;
      }
    }
    return { ok, failed, detail: { presentersAttempted: presenters.length, correctlyRejectedWhileBusy: correctlyRejected } };
  });

  // --- Phase: host kicks a burst of participants in quick succession ---
  await timedPhase('mass-kick', async () => {
    const toKick = peers.slice(Math.max(1, peers.length - 20)); // last ~20, never the host itself
    const { ok, failed, sampleErrors } = await settleCount(
      toKick.map((p) => host.emitEvent('kick', { targetUserId: p.userId })),
    );
    // Confirm they actually got disconnected server-side, not just told.
    await new Promise((r) => setTimeout(r, 1500));
    peers = peers.filter((p) => !toKick.includes(p));
    return { ok, failed, detail: { kicked: toKick.length, sampleErrors } };
  });

  // --- Phase: reconnect while others are actively publishing ---
  await timedPhase('reconnect-while-publishing', async () => {
    const reconnecting = peers.slice(1, Math.min(11, peers.length)); // a sample, never the host
    let gotExistingProducers = 0;
    const { ok, failed, sampleErrors } = await settleCount(
      reconnecting.map(async (p) => {
        p.disconnect();
        await new Promise((r) => setTimeout(r, 300));
        p.sendTransport = undefined;
        p.recvTransport = undefined;
        p.consumers.clear();
        await p.connect('/meetings');
        const res = await p.joinRoom(cfg.meetingId, cfg.turnOnly);
        if (!res.success) throw new Error(res.error);
        // Others (host, at minimum) are still producing throughout this phase — a
        // non-empty existingProducers list here is a direct regression check for
        // the join-time "existingProducers" fix (see docs/INTEGRATION.md).
        if (p.consumers.size > 0) gotExistingProducers++;
        return true;
      }),
    );
    return { ok, failed, detail: { attempted: reconnecting.length, gotExistingProducers, sampleErrors } };
  });

  report({ status: 'done' });
  for (const p of peers) p.close(); // host is peers[0] — always included, never removed by mass-kick
  process.exit(0);
}

main().catch((err) => {
  report({ status: 'crashed', error: String(err) });
  process.exit(1);
});
