# call-service testing

E2E scenario tests (real Chromium + real mediasoup-client, via Playwright) and a
configurable-scale synthetic load test, for the `call-service` in the parent directory.

## Adaptations from a generic spec — read this first

This suite was built against a specific instruction set that assumed an "existing NestJS
backend" with user register/login APIs. That backend doesn't exist in this repo —
`call-service` is standalone (see `../README.md`) and only *verifies* JWTs, it doesn't
issue them. Three concrete adaptations, each called out again at its point of use in code:

1. **User generation mints JWTs locally** (`users/generate-users.ts`) instead of calling
   register/login endpoints — using the same `sub`/`name`/`avatarUrl` claims shape
   `call-service` actually expects (`docs/INTEGRATION.md` §2.1).
2. **Screen share uses a canvas-captured `MediaStream`**, not `getDisplayMedia()` — headless
   Chromium has no real display to capture. `call-service`'s screen-share logic keys off
   `appData.source === 'screen'`, not pixel content, so this exercises the real server-side
   code path (single-presenter enforcement, broadcasts) without needing an actual screen.
3. **The 500-participant load test uses synthetic socket.io-client connections, not real
   browsers.** Real mediasoup Router/Transport/Producer objects are genuinely allocated
   server-side for each one (so it does stress real memory/CPU), but no real RTP flows,
   since that needs an actual DTLS handshake a scripted client can't complete. Spinning up
   500 real Chromium instances isn't practical on any single machine — that's not how
   SFUs are load-tested at this scale in practice either. Real media verification lives in
   the 17 Playwright scenarios instead, at a scale (12 participants) real browser
   automation can actually sustain.

## Setup

```bash
npm install
npx playwright install chromium   # add --with-deps if your OS has apt and sudo access
cp .env.example .env              # point at your running call-service instance
npm run generate:users
```

## Running

```bash
npm test                 # all 17 scenarios (needs call-service running — see ../README.md)
npx playwright show-report reports/html   # after a run

npm run load:50          # synthetic load test, 50 participants
npm run load:500         # ... 500 — see the honest caveat above about what this does/doesn't prove
# or directly: tsx load-test/load-test.ts --participants=250 --duration=45 --pid=<call-service PID>

# Real-media stress test (stress/) — see the full section below before running at scale.
npx tsx stress/coordinator.ts --processes=5 --participants=100
npx tsx stress/coordinator.ts --processes=2 --participants=15 --turn-only=true   # needs a running coturn, see below
npx tsx stress/coordinator.ts --processes=2 --participants=15 --loss=0.15
npx tsx stress/coordinator.ts --processes=2 --participants=15 --latency=250
```

`--pid` (optional) lets the load test sample the call-service process's real RSS/CPU via
`ps` during the run — pass it when running against a local `node dist/main.js`, skip it
against a container/remote host you don't have a local PID for.

## What's real vs. simulated

| | Real | Simulated |
|---|---|---|
| Scenarios (`scenarios/*.spec.ts`) | Auth, signaling, ICE/DTLS, RTP flow (real audio/video tracks via Chromium's fake-device flags), server-side state/permissions | Screen content (canvas, not a real screen); camera/mic content (Chromium's synthetic test pattern, not real people) |
| Load test (`load-test/`) | Auth, signaling, mediasoup resource allocation (real Router/Transport/Producer objects server-side), server memory/CPU under connection churn | RTP flow (no real media bytes ever sent — no browser, no real DTLS) |
| Media stress test (`stress/`) | Everything the load test does, **plus real ICE/DTLS/SRTP** — genuine encrypted RTP sent, mediasoup-relayed, and received between independent Node.js processes (no browser at all, via `werift`; see below) | Packet *content* isn't decodable audio/video (synthetic payload bytes at realistic size/cadence); packet loss/latency are applied at the sender before the packet ever leaves the process, not via real OS-level network impairment (`tc netem` needs root, unavailable in this sandbox — see below) |

## What the load test actually found, run on this dev machine

Not a substitute for testing on your real target hardware, but concrete and reproducible:

- **5 / 50 participants** joining one meeting: 100% success, peak ~90-120MB RSS, sub-200ms
  p95 latency on every action (join, produce, chat, reactions, raise hand).
- **100 participants into one meeting, and separately 500 across 5 meetings (100 each)**:
  both capped at the same ~60 total successful `joinRoom` calls before the rest timed out
  (10s) — splitting into 5 separate rooms (5 separate mediasoup Routers, distributed across
  workers by `WorkerPoolService.getLeastLoadedWorker()`) made **no measurable difference**,
  which directly contradicts a "one busy room is CPU-bound to one worker" theory this
  document originally stated after just the 100-in-one-room result. Don't trust a
  single-data-point theory — the room-sharded rerun is exactly the check that broke it.
  Checked properly this time before writing anything down: sampled the call-service
  process's own CPU (`--pid`) *and* all 4 mediasoup worker processes' CPU directly via `ps`
  during a fresh run. Server main process peaked at **~30%** of one core; **every mediasoup
  worker read 0.0% CPU for the entire run.** The server was idle. The ~60-join ceiling is a
  limitation of this load-test *tool* — one Node.js process synchronously JWT-signing and
  juggling hundreds of concurrent sockets/timers/promises — not of call-service. A real
  capacity ceiling test needs either multiple load-generator processes/machines or the
  Playwright-based real-browser scenarios (naturally paced by actual client startup cost).
  Room sharding may still matter at real production scale — this test just didn't prove it
  either way, and says so honestly rather than keep a plausible-sounding wrong conclusion.

## Media stress test (`stress/`) — real audio/video, not just joins

The load test above proves signaling holds up at scale but never sends a real media byte.
This one does — using [`werift`](https://github.com/shinyoshiaki/werift-webrtc), a
pure-JavaScript WebRTC implementation, `stress/media-peer.ts` runs `mediasoup-client`
(the same library the browser scenarios use) **in plain Node.js, no browser at all**, by
shimming just enough of the DOM WebRTC surface (`mediasoup-client` picks its handler via
`navigator.userAgent` sniffing, not feature detection — see `stress/webrtc-shim.ts`).
Verified end to end before anything was built on top of it: two independent Node processes,
zero browsers, real ICE+DTLS reaching `connected`, a real SRTP-encrypted RTP packet sent by
one and genuinely decrypted and received by the other via call-service's mediasoup Router.

Architecture matches what was asked for exactly:

```
coordinator.ts  →  fork()s N real OS processes (not async concurrency in one event loop)
                    each running worker-process.ts
                      → M real MediaPeer instances (werift), one meeting per process
                      → runs a fixed phase sequence, IPC's results back per phase
```

Phases, run for every process's room in parallel: join → everyone enables audio
simultaneously → everyone enables video simultaneously → real media stats sample →
camera-toggle storm (3 cycles) → rapid mute/unmute storm (10 cycles) → screen-share handoffs
(single-presenter enforcement under contention) → mass kick (last ~20 participants, in one
burst) → reconnect while others are actively publishing (direct regression check for the
`existingProducers` join-time fix — see `docs/INTEGRATION.md`).

### Real bugs this harness's *own* development found (in itself, not call-service)

Building and actually running this surfaced three real bugs in the harness before the
numbers below could be trusted — worth listing because they're exactly the kind of thing
that silently corrupts stress-test results if not caught:

1. **Wrong host ID.** `coordinator.ts` created each meeting via REST with one host ID but
   told the worker process a *different* one for `peers[0]` — so the "host" peer was never
   actually recognized as host server-side. Every `mass-kick` attempt failed with a
   permission error until this was fixed to reuse the exact same ID for both.
2. **Fire-and-forget metrics.** `Promise.allSettled`-based counting treated "the promise
   resolved without throwing" as success — but `pauseProducer`/`resumeProducer` etc. return
   `false` (not a throw) on failure, so every graceful failure was counted as a pass. Fixed
   by checking actual resolved values/`.success` fields, not just settlement.
3. **`Promise.all` fails fast.** `mass-kick` and `screen-share-handoffs` used `Promise.all`
   across many concurrent operations — one single timed-out call aborted the *entire* phase
   for that process, and the coordinator's aggregation silently zeroed out crashed phases
   instead of surfacing them (4 of 5 processes' `mass-kick` phase crashed in one run and the
   summary just showed "20 failed" with no indication 80 more attempts never even ran).
   Fixed with per-operation fault isolation and a distinct `crashed` count that's never
   folded into `failed`.

### What was actually found, run on this machine (4 CPU cores, shared with a live desktop session)

- **Every functional phase — real audio, real video, camera/mute storms, screen-share
  handoffs, mass kick, reconnect-while-publishing — passes cleanly at ~30 real participants
  per process** (validated at 2×15 and 2×30). The `existingProducers` regression check
  passed 100% of the time it got to run (9/9, then 18/18 on a larger validation run):
  reconnecting participants correctly received the room's already-active producers on
  rejoin, confirming that fix holds under genuine concurrent WebRTC load, not just the
  Playwright scenario that originally caught it.
- **The literal ask — 5 processes × 100 — hits a real ceiling: ~60 of 500 successfully
  join before the rest time out (10s).** Reshaping to 25 processes × 20 (same 500 total,
  well within each process's own proven-reliable ~30-peer capacity) produced the **same**
  ~60-success ceiling. That rules out "too many peers in one process" as the cause. Checked
  directly with `ps` sampling during a live run: **call-service's own process peaked around
  15-22% of one core; every mediasoup worker read effectively 0% CPU the entire time.** The
  5 (or 25) test-harness processes, by contrast, hit 85%, 73%, 55%, 48%, 48% of a core each,
  immediately. This machine has **4 CPU cores** and was running the author's live desktop
  session throughout. The honest conclusion: on this specific shared, resource-constrained
  sandbox, running enough simultaneous real-crypto Node.js processes to genuinely originate
  500 concurrent real WebRTC connections exceeds available CPU cores — that's a statement
  about *this test machine's core count*, not about call-service, which stayed idle and
  responsive the entire time regardless of how the 500 were shaped across processes.
  **This needs re-running on hardware with more real cores (or genuinely separate machines)
  to get a trustworthy answer to "what's call-service's real ceiling" — this sandbox can't
  answer that question, and this report says so rather than guessing.**
- **TURN-only** (`--turn-only=true`, forcing `iceTransportPolicy: 'relay'`): confirmed
  working at reliable scale (30/30 joins, real packets sent and relayed —
  `candidate-pair`'s selected local candidate type was `relay`, not `host`, confirming the
  media path genuinely went through coturn, not direct). Needed a test-only coturn config
  (`allow-loopback-peers`, relaxed `denied-peer-ip`) to work at all on a single loopback
  machine — the committed production `docker/coturn/turnserver.conf` correctly *blocks*
  exactly what this test needed to allow, which is itself a good sign the production
  hardening is doing its job, not a gap in it.
- **Packet loss (15%) and high latency (250ms)**: both simulated at the application layer
  in `MediaPeer` (drop a fraction of outgoing packets before `writeRtp`; delay others via
  `setTimeout`) — `tc netem` (real OS-level impairment) needs root/`CAP_NET_ADMIN`, which
  this sandbox doesn't have (confirmed: `tc qdisc add ... netem` → `Operation not
  permitted`). Both ran clean (30/30, every phase) — expected, since loss/latency at the RTP
  layer doesn't touch the signaling acks these phase metrics actually measure; a genuine
  loss/latency effect would show up in `packetsLost`/jitter within `getStats()`, not in
  phase ok/failed counts. If real OS-level impairment matters for your use case, run this
  from a host where you control `tc`, or between two real separate machines.

### Running it yourself

```bash
# TURN-only needs a coturn with a test-only config (real production config intentionally
# blocks loopback relay — see the finding above). Not committed; build it locally:
mkdir -p /tmp/stress-coturn
TURN_SECRET=$(openssl rand -hex 32)
sed "s/CHANGE_ME_TURN_SECRET/$TURN_SECRET/" ../docker/coturn/turnserver.conf > /tmp/stress-coturn/turnserver.conf
echo "allow-loopback-peers" >> /tmp/stress-coturn/turnserver.conf
docker run -d --name coturn-stress --network=host -v /tmp/stress-coturn/turnserver.conf:/etc/coturn/turnserver.conf:ro coturn/coturn:4.6 -c /etc/coturn/turnserver.conf
# set TURN_SECRET in call-service's .env to the same value, restart it

npx tsx stress/coordinator.ts --processes=2 --participants=30   # known-reliable on a 4-core box
```

## Reports

Scenario runs produce Playwright's own JSON (`reports/results.json`), JUnit XML
(`reports/junit.xml`, CI-ready), and HTML (`reports/html/`, includes traces/screenshots on
failure) — no custom reporting code needed, Playwright's built-in reporters already cover
"passed/failed/timeline/logs/errors/screenshots." Load test runs write their own
`reports/load-test-<N>-<timestamp>.{json,html}` (latency percentiles per action, peak
memory/worker/participant counts) since they aren't Playwright tests.
