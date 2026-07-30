/**
 * Configurable-scale load test (50/100/250/500 "participants").
 *
 * Deliberately NOT real browsers: spinning up 500 real Chromium instances
 * isn't practical on any single machine, let alone this sandbox — that's
 * not how anyone actually load-tests an SFU at this scale in practice
 * either. Instead this uses lightweight socket.io-client connections that
 * exercise the full signaling path (auth, join, transport creation, produce
 * with a synthetic RTP fixture, chat/reactions/raise-hand/reconnect) —
 * real mediasoup Router/Transport/Producer objects really do get allocated
 * server-side for each one, which is what actually stresses memory/CPU at
 * scale. What it does NOT do is move real RTP bytes (no real DTLS handshake
 * completes without a real browser) — see scenarios/*.spec.ts (Playwright +
 * real Chromium) for genuine media-level verification, at a scale (12
 * participants) real browser automation can actually sustain.
 *
 * Usage: tsx load-test/load-test.ts --participants=50 [--rooms=1] [--duration=30] [--with-media=true] [--pid=<call-service PID>]
 *
 * --rooms distributes participants round-robin across N separate meetings
 * instead of one — each meeting's mediasoup Router lands on whichever
 * worker WorkerPoolService judges least loaded, so spreading load across
 * rooms is how this architecture actually scales past one room's single-CPU
 * ceiling (see testing/README.md's "what the load test actually found").
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import jwt from 'jsonwebtoken';
import { io, Socket } from 'socket.io-client';
import { config } from '../lib/config.js';
import { restClient } from '../lib/rest-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Args {
  participants: number;
  rooms: number;
  durationSeconds: number;
  withMedia: boolean;
  pid?: number;
}

function parseArgs(): Args {
  const raw = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v];
    }),
  );
  return {
    participants: Number(raw.participants ?? 50),
    rooms: Number(raw.rooms ?? 1),
    durationSeconds: Number(raw.duration ?? 30),
    withMedia: raw['with-media'] !== 'false',
    pid: raw.pid ? Number(raw.pid) : undefined,
  };
}

interface Sample {
  t: number;
  event: string;
  ms?: number;
  ok: boolean;
  detail?: string;
  roomIndex?: number;
}

interface ProcessSample {
  t: number;
  rssKb: number | null;
  cpuPercent: number | null;
}

function readProcessStats(pid: number): { rssKb: number | null; cpuPercent: number | null } {
  try {
    const out = execSync(`ps -o rss=,%cpu= -p ${pid}`, { encoding: 'utf8' }).trim();
    const [rss, cpu] = out.split(/\s+/).map(Number);
    return { rssKb: Number.isFinite(rss) ? rss : null, cpuPercent: Number.isFinite(cpu) ? cpu : null };
  } catch {
    return { rssKb: null, cpuPercent: null };
  }
}

function fakeOpusRtpParameters(ssrc: number) {
  return {
    codecs: [
      { mimeType: 'audio/opus', payloadType: 100, clockRate: 48000, channels: 2, parameters: { useinbandfec: 1 }, rtcpFeedback: [] },
    ],
    headerExtensions: [],
    encodings: [{ ssrc }],
    rtcp: { cname: `load-${ssrc}` },
  };
}

function ack<T>(socket: Socket, event: string, payload: unknown, timeoutMs = 10000): Promise<{ success: boolean; data?: T; error?: string; ms: number }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs);
    socket.emit(event, payload, (response: { success: boolean; data?: T; error?: string }) => {
      clearTimeout(timer);
      resolve({ ...response, ms: Date.now() - start });
    });
  });
}

async function runParticipant(
  index: number,
  meetingId: string,
  roomIndex: number,
  samples: Sample[],
  withMedia: boolean,
  durationSeconds: number,
): Promise<void> {
  const userId = `load-user-${index}`;
  const token = jwt.sign({ sub: userId, name: `Load User ${index}` }, config.jwtSecret, {
    algorithm: config.jwtAlgorithm,
    expiresIn: '1h',
  });

  const record = (event: string, ok: boolean, ms?: number, detail?: string) =>
    samples.push({ t: Date.now(), event, ok, ms, detail, roomIndex });

  const socket = io(`${config.callServiceWsUrl}/meetings`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    timeout: 10000,
  });

  const connectStart = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), 10000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    record('connect', true, Date.now() - connectStart);
  } catch (err) {
    record('connect', false, Date.now() - connectStart, String(err));
    return;
  }

  try {
    const joinAck = await ack(socket, 'joinRoom', { meetingId });
    record('joinRoom', joinAck.success, joinAck.ms, joinAck.error);
    if (!joinAck.success) {
      socket.disconnect();
      return;
    }

    if (withMedia) {
      const transportAck = await ack<{ id: string }>(socket, 'createTransport', { meetingId, direction: 'send' });
      record('createTransport', transportAck.success, transportAck.ms, transportAck.error);

      if (transportAck.success && transportAck.data) {
        const produceAck = await ack(socket, 'produce', {
          meetingId,
          transportId: transportAck.data.id,
          kind: 'audio',
          rtpParameters: fakeOpusRtpParameters(1_000_000 + index),
          appData: { source: 'mic' },
        });
        record('produce', produceAck.success, produceAck.ms, produceAck.error);
      }
    }

    // Randomized activity for the test's duration: mute/unmute, reactions,
    // raise hand, chat, occasional reconnect — mirrors real usage patterns
    // rather than a single burst.
    const deadline = Date.now() + durationSeconds * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 1200));
      const roll = Math.random();
      if (roll < 0.25) {
        const r = await ack(socket, 'reaction', { meetingId, emoji: '👍' });
        record('reaction', r.success, r.ms, r.error);
      } else if (roll < 0.4) {
        const r = await ack(socket, 'raiseHand', { meetingId });
        record('raiseHand', r.success, r.ms, r.error);
      } else if (roll < 0.55) {
        const r = await ack(socket, 'chatMessage', { meetingId, text: `msg from ${userId}` });
        record('chatMessage', r.success, r.ms, r.error);
      } else if (roll < 0.6 && index % 10 === 0) {
        // A minority of participants simulate a reconnect, not everyone —
        // matches real-world churn rather than a synchronized mass drop.
        socket.disconnect();
        record('reconnect:disconnect', true);
        await new Promise((r) => setTimeout(r, 500));
        socket.connect();
        await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
        const rejoin = await ack(socket, 'joinRoom', { meetingId });
        record('reconnect:rejoin', rejoin.success, rejoin.ms, rejoin.error);
      }
    }
  } catch (err) {
    // A single participant's unexpected failure (e.g. an ack timing out
    // under real load) must never abort the whole run — that's exactly the
    // kind of thing this tool exists to measure, not crash on. Recorded as
    // a normal failed sample so it shows up in the report's summary/failure
    // breakdown instead of taking down every other participant's results.
    record('unexpected', false, undefined, String(err));
  } finally {
    socket.disconnect();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(
    `Load test: ${args.participants} participants across ${args.rooms} room(s), ${args.durationSeconds}s duration, media=${args.withMedia}`,
  );

  const meetings = await Promise.all(
    Array.from({ length: args.rooms }, (_, i) =>
      restClient.createMeeting(`load-host-${Date.now()}-${i}`, { chatEnabled: true, reactionsEnabled: true }),
    ),
  );
  console.log(`Meetings created: ${meetings.map((m) => m.id).join(', ')}`);

  const samples: Sample[] = [];
  const processSamples: ProcessSample[] = [];
  const healthSamples: Array<{ t: number; health: Awaited<ReturnType<typeof restClient.health>> }> = [];

  let stopMonitoring = false;
  const monitor = (async () => {
    while (!stopMonitoring) {
      if (args.pid) processSamples.push({ t: Date.now(), ...readProcessStats(args.pid) });
      try {
        healthSamples.push({ t: Date.now(), health: await restClient.health() });
      } catch {
        /* server may be momentarily busy under load — skip this sample */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();

  const start = Date.now();
  // Ramp up in small batches rather than a single synchronous burst of N
  // connections — closer to real traffic and avoids the test harness itself
  // becoming the bottleneck (Node's own event loop, not the server, being
  // what actually throttles a naive "fire N at once").
  const BATCH_SIZE = 25;
  const participantPromises: Promise<void>[] = [];
  for (let i = 0; i < args.participants; i += BATCH_SIZE) {
    const batch = Array.from({ length: Math.min(BATCH_SIZE, args.participants - i) }, (_, j) => {
      const roomIndex = (i + j) % args.rooms; // round-robin across rooms
      return runParticipant(i + j, meetings[roomIndex].id, roomIndex, samples, args.withMedia, args.durationSeconds);
    });
    participantPromises.push(...batch);
    await new Promise((r) => setTimeout(r, 250));
  }

  await Promise.all(participantPromises);
  stopMonitoring = true;
  await monitor;
  const totalMs = Date.now() - start;

  await Promise.all(meetings.map((m) => restClient.endMeeting(m.id).catch(() => {})));

  writeReport(args, samples, processSamples, healthSamples, totalMs);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function writeReport(
  args: Args,
  samples: Sample[],
  processSamples: ProcessSample[],
  healthSamples: Array<{ t: number; health: Awaited<ReturnType<typeof restClient.health>> }>,
  totalMs: number,
): void {
  const byEvent = new Map<string, Sample[]>();
  for (const s of samples) {
    if (!byEvent.has(s.event)) byEvent.set(s.event, []);
    byEvent.get(s.event)!.push(s);
  }

  const summary = [...byEvent.entries()].map(([event, list]) => {
    const ok = list.filter((s) => s.ok).length;
    const times = list.map((s) => s.ms).filter((v): v is number => v !== undefined);
    return {
      event,
      count: list.length,
      ok,
      failed: list.length - ok,
      p50Ms: percentile(times, 50),
      p95Ms: percentile(times, 95),
      p99Ms: percentile(times, 99),
      maxMs: times.length ? Math.max(...times) : 0,
    };
  });

  // Per-room breakdown of joinRoom success — the whole point of --rooms>1 is
  // comparing "N participants in one room" against "N participants spread
  // across rooms", so this needs to be visible per room, not just aggregated.
  const joinSamples = samples.filter((s) => s.event === 'joinRoom');
  const byRoom = new Map<number, Sample[]>();
  for (const s of joinSamples) {
    const idx = s.roomIndex ?? 0;
    if (!byRoom.has(idx)) byRoom.set(idx, []);
    byRoom.get(idx)!.push(s);
  }
  const roomBreakdown = [...byRoom.entries()]
    .sort(([a], [b]) => a - b)
    .map(([roomIndex, list]) => ({
      roomIndex,
      ok: list.filter((s) => s.ok).length,
      count: list.length,
    }));

  const peakRssKb = Math.max(0, ...processSamples.map((s) => s.rssKb ?? 0));
  const peakWorkers = Math.max(0, ...healthSamples.map((s) => s.health.mediasoup.workerCount));
  const peakParticipants = Math.max(0, ...healthSamples.map((s) => s.health.meetings.totalParticipants));

  // Distinct failure reasons with counts — the summary table says *how many*
  // failed, this says *why*, grouped so one root cause doesn't read as N
  // separate mystery failures.
  const failureReasons = new Map<string, number>();
  for (const s of samples) {
    if (!s.ok) {
      const key = `${s.event}: ${s.detail ?? 'no detail'}`;
      failureReasons.set(key, (failureReasons.get(key) ?? 0) + 1);
    }
  }
  const failures = [...failureReasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const report = {
    args,
    totalMs,
    summary,
    roomBreakdown,
    failures,
    peakRssKb: peakRssKb || null,
    peakWorkers,
    peakParticipants,
    processSamples,
    healthSamples,
    generatedAt: new Date().toISOString(),
  };

  const reportsDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const base = `load-test-${args.participants}-${Date.now()}`;
  fs.writeFileSync(path.join(reportsDir, `${base}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(reportsDir, `${base}.html`), renderHtml(report));

  console.log(`\n=== Load test summary (${args.participants} participants, ${(totalMs / 1000).toFixed(1)}s) ===`);
  for (const row of summary) {
    console.log(
      `  ${row.event.padEnd(20)} ok=${row.ok}/${row.count}  p50=${row.p50Ms}ms  p95=${row.p95Ms}ms  max=${row.maxMs}ms`,
    );
  }
  if (args.rooms > 1) {
    console.log('\n  Per-room joinRoom success:');
    for (const r of roomBreakdown) console.log(`    room ${r.roomIndex}: ${r.ok}/${r.count}`);
  }
  if (failures.length) {
    console.log('\n  Failure reasons:');
    for (const f of failures) console.log(`    ${f.count}x  ${f.reason}`);
  }
  if (peakRssKb) console.log(`  peak RSS: ${(peakRssKb / 1024).toFixed(1)}MB`);
  console.log(`  peak workers: ${peakWorkers}, peak reported participants: ${peakParticipants}`);
  console.log(`Report written to ${path.join(reportsDir, base)}.{json,html}`);
}

function renderHtml(report: ReturnType<typeof buildReportShape>): string {
  const rows = report.summary
    .map(
      (r: { event: string; count: number; ok: number; failed: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }) => `
    <tr class="${r.failed > 0 ? 'bad' : ''}">
      <td>${r.event}</td><td>${r.ok}/${r.count}</td><td>${r.p50Ms}</td><td>${r.p95Ms}</td><td>${r.p99Ms}</td><td>${r.maxMs}</td>
    </tr>`,
    )
    .join('');

  const failureRows = report.failures
    .map((f: { reason: string; count: number }) => `<tr><td>${f.count}</td><td>${escapeHtml(f.reason)}</td></tr>`)
    .join('');

  const roomRows = report.roomBreakdown
    .map((r: { roomIndex: number; ok: number; count: number }) => `<tr><td>${r.roomIndex}</td><td>${r.ok}/${r.count}</td></tr>`)
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Load test report</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;color:#1a1a1a}
table{border-collapse:collapse;width:100%;margin-top:1rem}
th,td{border:1px solid #ddd;padding:.5rem .75rem;text-align:right}
th:first-child,td:first-child{text-align:left}
th{background:#f4f4f4}
tr.bad{background:#fff0f0}
.meta{color:#555}
</style></head><body>
<h1>Load test report</h1>
<p class="meta">${report.args.participants} participants across ${report.args.rooms} room(s), ${report.args.durationSeconds}s duration, media=${report.args.withMedia}, total ${(report.totalMs / 1000).toFixed(1)}s, generated ${report.generatedAt}</p>
<p class="meta">Peak RSS: ${report.peakRssKb ? (report.peakRssKb / 1024).toFixed(1) + 'MB' : 'n/a (no --pid given)'} · Peak workers: ${report.peakWorkers} · Peak reported participants: ${report.peakParticipants}</p>
<table>
<thead><tr><th>Event</th><th>OK/Total</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th><th>max ms</th></tr></thead>
<tbody>${rows}</tbody>
</table>
${report.args.rooms > 1 ? `<h2>Per-room joinRoom success</h2><table><thead><tr><th>Room</th><th>OK/Total</th></tr></thead><tbody>${roomRows}</tbody></table>` : ''}
${report.failures.length ? `<h2>Failure reasons</h2><table><thead><tr><th>Count</th><th>Reason</th></tr></thead><tbody>${failureRows}</tbody></table>` : ''}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// Type helper only — keeps renderHtml's param typed without re-declaring the report shape twice.
function buildReportShape() {
  return {} as {
    args: Args;
    totalMs: number;
    summary: Array<{ event: string; count: number; ok: number; failed: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }>;
    roomBreakdown: Array<{ roomIndex: number; ok: number; count: number }>;
    failures: Array<{ reason: string; count: number }>;
    peakRssKb: number | null;
    peakWorkers: number;
    peakParticipants: number;
    generatedAt: string;
  };
}

main().catch((err) => {
  console.error('Load test crashed:', err);
  process.exitCode = 1;
});
