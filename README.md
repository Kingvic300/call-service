# call-service

Standalone WebRTC conferencing service (mediasoup SFU + coturn) for the existing NestJS
backend. Handles WebRTC signaling, media routing, meeting state, and presence; the backend
keeps auth, user management, notifications, and scheduling. No Twilio/Agora/Daily/LiveKit,
no managed TURN — only mediasoup, coturn, Socket.IO, Node.js, TypeScript.

```
React / Mobile → Existing NestJS Backend (JWT, scheduling) → call-service (this repo) → mediasoup Workers → coturn
```

**Wiring this up against your backend or frontend? See [docs/INTEGRATION.md](docs/INTEGRATION.md)**
for the full REST + Socket.IO contract (endpoints, event payloads, auth, a complete
join/produce/consume client flow).

## Two endpoints, one mediasoup core

This service exposes **two separate Socket.IO namespaces and REST prefixes**, not one
generic "calls" surface, because 1:1 calls and group meetings have genuinely different
shapes:

| | `/calls` (1:1) | `/meetings` (group / large standup) |
|---|---|---|
| REST prefix | `POST /calls`, `GET /calls/:id`, `POST /calls/:id/end` | `POST /meetings`, `GET /meetings/:id`, `POST /meetings/:id/end`, `DELETE /meetings/:id`, plus `/meetings/:id/{mute,kick,remove,promote,demote,lock,unlock}` |
| Gateway | `CallsGateway` | `MeetingsGateway` |
| Host/moderator hierarchy | none — either party can end the call | host + moderator + participant, configurable permissions |
| Chat, reactions, raise hand | — | ✅ |
| Waiting room, lock meeting | — | ✅ |
| Screen share | ✅ | ✅ |

Both gateways delegate the actual mediasoup work (transports, producers, consumers,
simulcast, ICE restart, active-speaker detection) to one shared `SignalingService`
(`src/websocket/signaling.service.ts`) — see that file's doc comment for why this is
composition rather than a shared gateway base class (Nest's `@SubscribeMessage` scanner
does not reliably pick up handlers declared only in a parent class).

A `Meeting`'s `type` (`one_to_one` | `group`) fixes which namespace it lives on
(`NAMESPACE_BY_TYPE` in `meeting.entity.ts`); `RealtimeBroadcaster` is namespace-aware so
REST-triggered moderation (e.g. a backend call to `POST /meetings/:id/kick`) reaches the
right namespace's live sockets without the broadcaster having to guess.

## Request/response socket events use ack callbacks, not paired event names

`joinRoom`, `createTransport`, `connectTransport`, `produce`, `consume`, etc. are called
with a Socket.IO ack callback:

```js
socket.emit('produce', { meetingId, transportId, kind, rtpParameters }, (ack) => {
  if (!ack.success) return console.error(ack.error);
  console.log(ack.data.id); // producerId
});
```

Every such handler returns `{ success: boolean, data?, error? }` (see
`websocket/ws-response.util.ts`) instead of throwing a raw `WsException`, because Nest's
default WS exception filter doesn't feed back into ack callbacks — this keeps client-side
error handling uniform. One-way broadcasts (`userJoined`, `newProducer`, `reaction`,
`chatMessage`, ...) are plain `emit`s to the room, listed in
`src/interfaces/socket-events.enum.ts`.

## Auth

- **Sockets** (both namespaces): `handshake.auth.token` or an `Authorization: Bearer`
  header, a JWT issued by the existing backend, verified with `JWT_SECRET`/`JWT_ALGORITHM`.
  Client-supplied role/permission claims are never trusted — role is always resolved
  server-side (`ParticipantService.resolveRole`: `hostId` match → host, everyone else →
  participant, promotions tracked live).
- **REST** (backend → call-service only, never called by browsers/mobile): `X-API-Key`
  header checked against `INTERNAL_API_KEYS` (comma-separated, supports rotation) with a
  constant-time comparison. These endpoints treat the caller as already-authorized — the
  backend is expected to have checked the requesting user's host/moderator permission
  before calling e.g. `POST /meetings/:id/mute`.

## mediasoup architecture

- **Workers** (`workers/worker-pool.service.ts`): one per CPU core by default
  (`MEDIASOUP_NUM_WORKERS` to override), each pinned to its own OS process. A crashed
  worker is respawned automatically; rooms it was hosting are unrecoverable (mediasoup has
  no live migration) and clients must rejoin.
- **Routers** (`mediasoup/router-manager.service.ts`): one per meeting, created lazily on
  the least-loaded worker (`WorkerPoolService.getLeastLoadedWorker`) — this is the
  CPU-aware allocation and room-sharding foundation the spec asks for. Each router also
  owns an `AudioLevelObserver` for active-speaker detection, broadcast as
  `activeSpeakerChanged`.
- **Transports/Producers/Consumers** (`mediasoup/transport.service.ts`,
  `producer-consumer.service.ts`): standard WebRTC transports, Opus/VP8/VP9/H264 codecs,
  3-layer simulcast (`SIMULCAST_ENCODINGS` in `config/mediasoup.config.ts`), consumers
  created paused and resumed by the client once ready, `setPreferredLayers` exposed for
  quality downgrade of off-screen/inactive tiles, ICE restart wired end-to-end
  (`restartIce` socket event → `transport.restartIce()`).
- **Data producers/consumers**: mediasoup supports these natively and nothing here blocks
  adding them, but chat/reactions/raise-hand are deliberately carried over the existing
  Socket.IO connection instead of a mediasoup `DataChannel` — one signaling transport is
  simpler to reason about and rate-limit than two, and Socket.IO already fans out to a room
  correctly at the scales this spec targets.

## coturn

`coturn/coturn.service.ts` issues short-lived TURN credentials using coturn's
`use-auth-secret` REST API convention — `username = "<expiry>:<userId>"`,
`credential = base64(HMAC-SHA1(TURN_SECRET, username))`. coturn re-derives the same value
independently at auth time, so there's no per-user secret to provision, store, or rotate —
only `TURN_SECRET`, which is never sent to a client (`iceServers` handed to the browser only
ever contains the derived, time-limited username/credential pair). Config template:
`docker/coturn/turnserver.conf` — **replace the `CHANGE_ME` placeholders before deploying.**

## What's fully implemented vs. architecture-only

Per an explicit scoping decision, this pass prioritized a real, running core over shallow
coverage of every line item in the original spec:

**Fully wired, not stubs:** JWT + API-key auth, mediasoup workers/routers/transports/
producers/consumers, simulcast, active-speaker detection, ICE restart, 1:1 calls, group
meetings, chat (bounded in-memory history), reactions (validated + rate-limited), raise
hand, screen share (single-presenter enforcement), host controls (mute/unmute-request/
kick/lock/unlock/end/disable-chat/disable-reactions/disable-screenshare/promote/demote),
configurable permissions (`interfaces/permission.enum.ts` + per-meeting overrides), waiting
room (admit/reject), coturn credential generation, rate limiting (connection + per-event),
structured logging, health check, Prometheus metrics, graceful worker respawn, Docker,
**cross-instance signaling** (opt-in via `REDIS_URL` — Socket.IO Redis adapter, a
Redis-backed meeting-ownership directory, sticky routing at socket join, and transparent
REST forwarding for moderation calls that land on a non-owning instance; see
"Multi-instance deployment" in `docs/INTEGRATION.md`).

**Architecture only, not fully implemented:**
- **Recording**: no muxing/storage pipeline. The natural extension point is a
  `PlainTransport` consuming each producer server-side and piping to an external recorder
  (e.g. GStreamer/ffmpeg over RTP) — intentionally not built, since it needs a storage/
  encoding decision this spec didn't make.
- **Room sharding across instances**: cross-instance *signaling* now works (see above),
  but a single meeting's mediasoup Router still only ever exists on the one instance that
  created it — there is no cross-instance mediasoup piping yet (`router.pipeToRouter`), so
  a meeting whose participant count exceeds one instance's local worker capacity has
  nowhere to overflow to. The worker-pool load-balancing (`WorkerPoolService`) is the
  foundation for this; the `shardId`/consistent-hash routing layer across instances isn't
  built.
- **`IMeetingRepository` stays in-memory on purpose**: a Meeting's live Participants own
  process-bound mediasoup Transport/Producer/Consumer objects (see
  `participant/entities/participant.entity.ts`) that can't be serialized into Redis or
  reconstructed on another instance — so instead of swapping this repository's storage,
  cross-instance visibility is handled by a separate, purpose-built ownership directory
  (`meeting/meeting-directory.service.ts`) plus REST forwarding to whichever instance
  actually holds the live state. See that file's doc comment for the full reasoning.

## What was and wasn't tested

No browser or WebRTC-capable client was available in this environment, so the actual
media path (DTLS handshake, RTP flow, simulcast switching) has **not** been exercised
end-to-end — that requires a real `mediasoup-client` in a browser or a WebRTC stack like
`wrtc`/`node-webrtc`, neither of which can run headless here. What *was* tested: a 10
simulated-client signaling load test (`scripts/signaling-load-test.ts`) exercising auth,
`joinRoom`/`leaveRoom`, transport/producer/consumer request shapes up to (not including)
the real DTLS `connectTransport` step, chat, reactions, raise hand, host mute/kick, lock,
and disconnect cleanup — see that script's own output for current pass/fail status.
**Before relying on this in production, run a real two-browser call end-to-end.**

## Environment variables

See `.env.example` for the full list with defaults and comments. Required with no default:
`JWT_SECRET`, `INTERNAL_API_KEYS`, `MEDIASOUP_ANNOUNCED_IP`, `TURN_HOST`, `TURN_SECRET`.

## Running locally

```bash
cp .env.example .env   # then fill in the required vars above
npm install
npm run start:dev
```

`docker-compose.yml` runs call-service + coturn together (`docker compose up --build`);
add `--profile scaling` to also start Redis.

## Folder structure

```
src/
├── auth/            JWT (sockets) + API key (backend REST) auth
├── calls/            1:1 call REST controller + gateway
├── chat/              room chat (bounded history)
├── config/            env validation, mediasoup config
├── coturn/            TURN/STUN credential generation
├── health/            GET /health
├── interfaces/        shared enums/types (roles, permissions, event names)
├── meeting/            meeting state, repository, waiting room, REST controller
├── mediasoup/          router/transport/producer/consumer management
├── metrics/            GET /metrics (Prometheus)
├── moderation/         host controls, permission checks
├── participant/        per-peer state + REST listing
├── reactions/          emoji reaction validation + throttling
├── screen-share/       single-presenter enforcement
├── utils/              WS payload validation, rate limiting
├── websocket/          shared signaling core + /meetings gateway
└── workers/             mediasoup worker pool
```
