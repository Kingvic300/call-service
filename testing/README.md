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
```

`--pid` (optional) lets the load test sample the call-service process's real RSS/CPU via
`ps` during the run — pass it when running against a local `node dist/main.js`, skip it
against a container/remote host you don't have a local PID for.

## What's real vs. simulated

| | Real | Simulated |
|---|---|---|
| Scenarios (`scenarios/*.spec.ts`) | Auth, signaling, ICE/DTLS, RTP flow (real audio/video tracks via Chromium's fake-device flags), server-side state/permissions | Screen content (canvas, not a real screen); camera/mic content (Chromium's synthetic test pattern, not real people) |
| Load test (`load-test/`) | Auth, signaling, mediasoup resource allocation (real Router/Transport/Producer objects server-side), server memory/CPU under connection churn | RTP flow (no real media bytes ever sent — no browser, no real DTLS) |

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

## Reports

Scenario runs produce Playwright's own JSON (`reports/results.json`), JUnit XML
(`reports/junit.xml`, CI-ready), and HTML (`reports/html/`, includes traces/screenshots on
failure) — no custom reporting code needed, Playwright's built-in reporters already cover
"passed/failed/timeline/logs/errors/screenshots." Load test runs write their own
`reports/load-test-<N>-<timestamp>.{json,html}` (latency percentiles per action, peak
memory/worker/participant counts) since they aren't Playwright tests.
