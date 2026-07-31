/**
 * Spawns N *real OS processes* (child_process.fork — not async concurrency
 * in one event loop) each running M real WebRTC participants (media-peer.ts,
 * via werift) in their own meeting, driving them through worker-process.ts's
 * media-stress phase sequence, and aggregates the results.
 *
 * Usage:
 *   tsx stress/coordinator.ts --processes=5 --participants=100 [--duration...]
 *     [--turn-only=true] [--loss=0.1] [--latency=200] [--max-consume=15]
 */
import { fork, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restClient } from '../lib/rest-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const raw = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v];
    }),
  );
  return {
    processes: Number(raw.processes ?? 5),
    participants: Number(raw.participants ?? 100),
    turnOnly: raw['turn-only'] === 'true',
    lossRate: raw.loss ? Number(raw.loss) : undefined,
    latencyMs: raw.latency ? Number(raw.latency) : undefined,
    maxConsume: Number(raw['max-consume'] ?? 15),
  };
}

interface WorkerReport {
  roomIndex: number;
  phases: Array<{ phase: string; startedAt: number; durationMs: number; ok: number; failed: number; crashed: boolean; detail?: Record<string, unknown> }>;
  sampleCounts: number;
  status?: string;
  error?: string;
}

async function main() {
  const args = parseArgs();
  console.log(
    `Media stress test: ${args.processes} processes x ${args.participants} participants ` +
      `(${args.processes * args.participants} total), turnOnly=${args.turnOnly}, ` +
      `loss=${args.lossRate ?? 0}, latency=${args.latencyMs ?? 0}ms`,
  );

  // Generate host IDs first and reuse the SAME value both to create the
  // meeting (REST, sets meeting.hostId) and to tell the worker which of its
  // MediaPeers is peers[0] — these must match exactly or the "host" peer
  // never actually gets host role server-side (found via a real failed
  // mass-kick phase during this harness's own development: every kick was
  // rejected with a permission error because of exactly this mismatch).
  const hostIds = Array.from({ length: args.processes }, (_, i) => `stress-host-${Date.now()}-${i}`);
  const meetings = await Promise.all(
    hostIds.map((hostId) => restClient.createMeeting(hostId, { chatEnabled: true, reactionsEnabled: true })),
  );
  console.log(`Created ${meetings.length} meetings, one per process.`);

  const workerScript = path.join(__dirname, 'worker-process.ts');
  const children: ChildProcess[] = [];
  const latestReports = new Map<number, WorkerReport>();

  const donePromises = meetings.map(
    (meeting, i) =>
      new Promise<void>((resolve) => {
        const child = fork(workerScript, [], {
          execArgv: ['--import', 'tsx/esm'],
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        children.push(child);

        child.on('message', (msg: WorkerReport) => {
          latestReports.set(i, msg);
          if (msg.status === 'done' || msg.status === 'crashed') resolve();
        });
        child.on('exit', () => resolve());
        child.on('error', (err) => {
          console.error(`Process ${i} failed to start:`, err);
          resolve();
        });

        child.send({
          roomIndex: i,
          meetingId: meeting.id,
          hostId: hostIds[i],
          participants: args.participants,
          turnOnly: args.turnOnly,
          impairment: { lossRate: args.lossRate, latencyMs: args.latencyMs },
          maxConsume: args.maxConsume,
        });
      }),
  );

  const start = Date.now();
  await Promise.all(donePromises);
  const totalMs = Date.now() - start;

  for (const child of children) child.kill();
  await Promise.all(meetings.map((m) => restClient.endMeeting(m.id).catch(() => {})));

  writeReport(args, [...latestReports.values()].sort((a, b) => a.roomIndex - b.roomIndex), totalMs);
}

function writeReport(args: ReturnType<typeof parseArgs>, reports: WorkerReport[], totalMs: number) {
  // Aggregate every process's same-named phase into one cross-process view —
  // "how did the camera-toggle-storm phase do across all 5 rooms combined."
  // `crashedProcesses` is tracked SEPARATELY from failed — a phase that
  // never finished in a given process must stay visible, not get folded
  // into ok=0/failed=0 (a real bug found during this harness's own
  // development: it silently hid 4/5 processes' mass-kick phase crashing).
  const byPhase = new Map<
    string,
    { ok: number; failed: number; crashedProcesses: number; durations: number[]; errorSamples: Set<string> }
  >();
  for (const r of reports) {
    for (const p of r.phases) {
      if (!byPhase.has(p.phase)) byPhase.set(p.phase, { ok: 0, failed: 0, crashedProcesses: 0, durations: [], errorSamples: new Set() });
      const agg = byPhase.get(p.phase)!;
      agg.ok += p.ok;
      agg.failed += p.failed;
      if (p.crashed) agg.crashedProcesses += 1;
      agg.durations.push(p.durationMs);
      const errs = p.detail?.sampleErrors;
      if (Array.isArray(errs)) for (const e of errs) agg.errorSamples.add(String(e));
      if (p.crashed && p.detail?.error) agg.errorSamples.add(`[process crashed] ${p.detail.error}`);
    }
  }
  const phaseSummary = [...byPhase.entries()].map(([phase, agg]) => ({
    phase,
    ok: agg.ok,
    failed: agg.failed,
    crashedProcesses: agg.crashedProcesses,
    avgDurationMs: Math.round(agg.durations.reduce((a, b) => a + b, 0) / agg.durations.length),
    errorSamples: [...agg.errorSamples].slice(0, 5),
  }));

  const crashed = reports.filter((r) => r.status === 'crashed');

  const report = { args, totalMs, phaseSummary, perProcess: reports, crashed: crashed.length, generatedAt: new Date().toISOString() };

  const reportsDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const base = `media-stress-${args.processes}x${args.participants}-${Date.now()}`;
  fs.writeFileSync(path.join(reportsDir, `${base}.json`), JSON.stringify(report, null, 2));

  console.log(`\n=== Media stress summary (${args.processes}x${args.participants}, ${(totalMs / 1000).toFixed(1)}s) ===`);
  for (const row of phaseSummary) {
    const crashNote = row.crashedProcesses ? `  [${row.crashedProcesses}/${args.processes} processes CRASHED on this phase]` : '';
    console.log(`  ${row.phase.padEnd(28)} ok=${row.ok} failed=${row.failed} avgDuration=${row.avgDurationMs}ms${crashNote}`);
    for (const e of row.errorSamples) console.log(`      ${e}`);
  }
  if (crashed.length) {
    console.log(`\n  ${crashed.length} process(es) CRASHED:`);
    for (const c of crashed) console.log(`    room ${c.roomIndex}: ${c.error}`);
  }
  console.log(`\nReport written to ${path.join(reportsDir, base)}.json`);
}

main().catch((err) => {
  console.error('Coordinator crashed:', err);
  process.exitCode = 1;
});
