# Integrating with call-service

This is the contract for two audiences:

1. **Backend engineers** — server-to-server REST calls (create/end meetings, moderation),
   authenticated with an (apiKey, secretKey) pair.
2. **Frontend/mobile engineers** — Socket.IO signaling for live calls, authenticated with
   that same (apiKey, secretKey) pair plus a plainly-asserted user identity (userId/
   displayName/avatarUrl) — call-service has no account relationship with end users of its
   own, so unlike a typical app it never verifies an end user's identity directly. Instead
   it authenticates the *service* cryptographically (the same trust model Twilio/Daily/
   Zoom-style video platform APIs use) and trusts whatever identity that already-
   authenticated service asserts for a given connection.

If you haven't read [../README.md](../README.md) yet, read it first — it explains *why*
the service is split into `/calls` (1:1) and `/meetings` (group), and what's fully
implemented vs. architecture-only. This document is the *how*.

---

## 1. Backend integration (REST)

Base URL: wherever call-service is deployed (e.g. `http://localhost:4000` locally).

Every endpoint below requires:

```
X-Api-Key: <your apiKey>
X-Secret-Key: <your secretKey>
```

One (apiKey, secretKey) pair per integrating service, configured server-side via
`SERVICE_CREDENTIALS` (comma-separated `apiKey:secretKey` pairs, so a new integrating
service or a rotated key can be added without downtime).

Missing or invalid headers → `401 { "message": "Missing or invalid X-API-Key/X-Secret-Key headers", "error": "Unauthorized", "statusCode": 401 }`.

These endpoints are for your backend to call — **never expose your secretKey to a
browser or mobile client.**

### 1:1 calls — `/calls`

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/calls` | `CreateCallDto` (below) | call state |
| GET | `/calls/:id` | — | call state |
| POST | `/calls/:id/end` | — | call state |

```ts
// CreateCallDto
{
  id?: string;        // UUID; omit to let the service generate one
  callerId: string;   // required — the initiating user's id
  mode?: 'audio_only' | 'video'; // default 'video'
}
```

Call state (`toStateJSON()`), same shape every endpoint returns:

```ts
{
  id: string;
  type: 'one_to_one' | 'group';
  mode: 'audio_only' | 'video';
  locked: boolean;
  chatEnabled: boolean;
  reactionsEnabled: boolean;
  screenShareEnabled: boolean;
  waitingRoomEnabled: boolean;
  activePresenterId: string | null;
  participantCount: number;
  instanceUrl?: string; // multi-instance mode only — see §5
}
```

> **Multi-instance deployments only** (§5): `instanceUrl` names the specific call-service
> instance that owns this call/meeting's mediasoup Router. Hand it to the client alongside
> `id` — the client's Socket.IO connection must be opened against `instanceUrl`, not
> whatever base URL your backend itself used to create the call. Absent (`undefined`) when
> `REDIS_URL` isn't set (single-instance mode) — clients keep connecting to the one
> instance as before.

Typical flow: your backend creates the call record via `POST /calls` when a user initiates
a 1:1 call (after your own ring/accept logic decides the call should actually start), hands
the returned `id` to both clients, and they connect to the `/calls` Socket.IO namespace and
`joinRoom` with that id. Call `POST /calls/:id/end` if you need to force-terminate from the
backend (e.g. an admin action, or a ring timeout before anyone joined).

### Group meetings / large standups — `/meetings`

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/meetings` | `CreateMeetingDto` | meeting state |
| GET | `/meetings/:id` | — | meeting state |
| POST | `/meetings/:id/end` | — | meeting state |
| DELETE | `/meetings/:id` | — | `{ deleted: true }` |
| POST | `/meetings/:id/mute` | `{ targetUserId }` | `{ muted: targetUserId }` |
| POST | `/meetings/:id/kick` | `{ targetUserId }` | `{ removed: targetUserId }` |
| POST | `/meetings/:id/remove` | `{ targetUserId }` | `{ removed: targetUserId }` (alias of `kick`) |
| POST | `/meetings/:id/promote` | `{ targetUserId }` | `{ promoted: targetUserId }` |
| POST | `/meetings/:id/demote` | `{ targetUserId }` | `{ demoted: targetUserId }` |
| POST | `/meetings/:id/lock` | — | `{ locked: true }` |
| POST | `/meetings/:id/unlock` | — | `{ locked: false }` |
| GET | `/participants/:meetingId` | — | array of participant state |

```ts
// CreateMeetingDto
{
  id?: string;
  hostId: string;               // required — becomes the meeting's host
  mode?: 'audio_only' | 'video';
  waitingRoomEnabled?: boolean; // default false
  chatEnabled?: boolean;        // default true
  reactionsEnabled?: boolean;   // default true
  screenShareEnabled?: boolean; // default true
}
```

Participant state (`toPublicJSON()`), returned by `GET /participants/:meetingId` as an array:

```ts
{
  userId: string;
  displayName: string;
  avatarUrl?: string;
  role: 'host' | 'moderator' | 'participant';
  audioMuted: boolean;
  videoEnabled: boolean;
  handRaised: boolean;
  presenting: boolean;
  joinedAt: string; // ISO 8601
}
```

**Important**: the REST moderation endpoints (`mute`/`kick`/`promote`/etc.) are *trusted* —
call-service assumes your backend already checked that the caller (a real end user) has
permission to do this before hitting the endpoint. Nothing here re-validates a "requester"
identity, because there isn't one in the request — these are service-to-service calls. If
you want the permission check enforced by call-service itself, do the action over the
socket instead (see §2.5) using the acting user's own connection, where role is resolved
from live meeting state, not a client-supplied claim.

### Operational endpoints (no auth)

- `GET /health` — `{ status: 'ok'|'degraded', uptimeSeconds, mediasoup: { workerCount, workers: [{pid, routerCount}] }, meetings: {...} }`
- `GET /metrics` — Prometheus text format (`call_service_mediasoup_workers`, `_routers`, `_active_meetings`, `_active_participants`, plus default Node process metrics)

---

## 2. Frontend/mobile integration (Socket.IO)

### 2.1 Connecting

Two independent namespaces on the same host — pick based on call type:

```js
import { io } from 'socket.io-client';

const socket = io(`${CALL_SERVICE_URL}/calls`, {    // or /meetings
  auth: {
    apiKey: SERVICE_API_KEY,       // your service's apiKey — never ship this to a browser/mobile client directly
    secretKey: SERVICE_SECRET_KEY, // ditto — see the note below
    userId: user.id,               // asserted plainly — your backend has already authenticated this user
    displayName: user.name,        // optional
    avatarUrl: user.avatarUrl,     // optional
  },
  transports: ['polling', 'websocket'],               // must include polling first
});
```

call-service authenticates the **calling service**, not the end user directly — it verifies
`(apiKey, secretKey)` against the shared `SERVICE_CREDENTIALS` and then trusts whatever
`userId`/`displayName`/`avatarUrl` that already-authenticated service asserts for the
connection. It never re-validates the end user's identity itself, because it has no account
relationship with end users of its own — your backend is the source of truth for "is this
really user X," the same way Twilio/Daily/Zoom-style video platform APIs work.

**Because `secretKey` must stay server-side, browsers/mobile apps should not open this
socket directly with your service's raw credentials.** The usual pattern: your backend
mints a short-lived, purpose-scoped credential for the client (or simply proxies the
Socket.IO connection itself), rather than embedding the service secretKey in client code.

If the credentials are invalid or missing, the server emits `errorEvent` (`{ message }`) and
disconnects the socket immediately. **Do not treat the Socket.IO `connect` event alone as
proof of authorization** — the disconnect can land a moment after `connect` fires. Listen
for `disconnect`/`connect_error` too if you need to detect rejection deterministically
(this bit our own test script during development — see the load test script's
`testUnauthorizedRejected` for the fixed pattern).

`transports: ['polling', 'websocket']` (not `['websocket']` alone) matters if you're behind
a proxy/load balancer that requires a polling handshake before a WebSocket upgrade can
succeed — get this wrong and every connection fails with a misleading CORS error instead of
a clean rejection (this exact class of bug has bitten this team before on a related
project — see the CallsGateway/MeetingsGateway `@WebSocketGateway` decorator options).

### 2.2 Request/response events use ack callbacks

Every action below (`joinRoom`, `createTransport`, `produce`, ...) is called with a
callback as the third argument — this is a Socket.IO ack, not a separate listener:

```js
socket.emit('produce', { meetingId, transportId, kind: 'audio', rtpParameters }, (ack) => {
  if (!ack.success) {
    console.error(ack.error);
    return;
  }
  console.log(ack.data.id); // the new producerId
});
```

Every ack has this shape:

```ts
{ success: boolean; data?: T; error?: string }
```

There is no separate error event for these — a rejected/invalid request always comes back
as `{ success: false, error: '<message>' }` on the same ack, never a thrown exception you
have to catch elsewhere. (Broadcasts like `newProducer`, `chatMessage`, `reaction` are
different — those are one-way `emit`s to the room, not acked.)

### 2.3 Call flow — join, transports, produce, consume

This sequence is identical on both namespaces; `/meetings` just has more events available
on top of it.

**1. Join the room**

```js
socket.emit('joinRoom', { meetingId }, (ack) => { ... });
```

If the meeting has a waiting room enabled and you're not the host, you get back
`{ waiting: true }` and nothing else — wait for the server to `emit('admitted', joinResult)`
once a host calls `admitWaitingParticipant` (or `emit('waitingRoomRejected', ...)` followed
by a disconnect if the host rejects you).

Otherwise you get the full join result:

```ts
{
  waiting: false;
  rtpCapabilities: RtpCapabilities;       // pass straight to mediasoup-client's Device.load()
  participants: ParticipantPublicJSON[];  // everyone already in the room (not including you)
  meetingState: MeetingStateJSON;         // same shape as the REST "meeting state" above
  iceServers: IceServer[];                // hand straight to RTCPeerConnection / mediasoup-client
  self: ParticipantPublicJSON;            // your own resolved role/state
  chatHistory: ChatMessage[];             // recent messages (bounded, CHAT_HISTORY_LIMIT) — empty for 1:1 calls
  existingProducers: Array<{              // producers that existed BEFORE you joined — see below
    producerId: string; peerId: string; kind: 'audio' | 'video'; appData: Record<string, unknown>;
  }>;
}
```

**`existingProducers` matters — don't skip it.** The `newProducer` broadcast (step 5 below)
only fires for producers created *after* you're already in the room. If the host's camera
was already on before you joined, you will never get a `newProducer` event for it — you
have to consume everything in `existingProducers` yourself, right after joining, the same
way you'd handle a live `newProducer`. This bit our own test suite during development
(`testing/scenarios/03-standup-12.spec.ts` — a participant joining after the host started
producing simply never saw their video) before this field existed.

`iceServers` is a ready-to-use array (STUN + three TURN variants: UDP, TCP, TLS), each TURN
entry carrying a `username`/`credential` pair that's valid for `TURN_CREDENTIAL_TTL_SECONDS`
(24h by default) — generated fresh per join, never reused across users.

**2. Load your mediasoup-client Device**

```js
await device.load({ routerRtpCapabilities: joinResult.rtpCapabilities });
```

**3. Create transports** (one `send`, one `recv` — standard mediasoup-client pattern)

```js
socket.emit('createTransport', { meetingId, direction: 'send' }, (ack) => {
  const sendTransport = device.createSendTransport(ack.data); // { id, iceParameters, iceCandidates, dtlsParameters }
  sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.emit('connectTransport', { meetingId, transportId: sendTransport.id, dtlsParameters }, (ack) =>
      ack.success ? callback() : errback(new Error(ack.error)),
    );
  });
  sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
    socket.emit('produce', { meetingId, transportId: sendTransport.id, kind, rtpParameters, appData }, (ack) =>
      ack.success ? callback({ id: ack.data.id }) : errback(new Error(ack.error)),
    );
  });
});
```

Repeat with `direction: 'recv'` for the receive transport, wiring only the `connect` event
(mediasoup-client handles `consume` itself once you call `transport.consume(...)`).

**4. Produce your own audio/video**

```js
const track = localStream.getAudioTracks()[0];
await sendTransport.produce({ track, appData: { source: 'mic' } });
```

`appData.source` is how call-service tells screen share apart from camera video —
use `'mic'`/`'camera'` for normal tracks and **`'screen'`** for a screen-share video track
(see §2.4). `appData.peerId` is ignored if you send it — the server always stamps the real
one server-side.

**5. Consume other participants' media**

Listen for `newProducer` broadcasts (fired to everyone already in the room whenever someone
else starts producing) and consume each one:

```js
socket.on('newProducer', ({ producerId, peerId, kind, appData }) => {
  socket.emit(
    'consume',
    { meetingId, transportId: recvTransport.id, producerId, rtpCapabilities: device.rtpCapabilities },
    async (ack) => {
      if (!ack.success) return;
      const consumer = await recvTransport.consume(ack.data); // { id, producerId, kind, rtpParameters, producerPaused }
      socket.emit('resumeConsumer', { meetingId, consumerId: consumer.id }, () => {});
      // attach consumer.track to a <video>/<audio> element
    },
  );
});
```

Consumers are created **paused** server-side on purpose — call `resumeConsumer` once your
media element is actually ready to render, to avoid a burst of packets you can't use yet.

**6. Mute/camera toggle, screen share stop, ICE restart**

```js
socket.emit('pauseProducer', { meetingId, producerId }, ack => {...});   // mute mic / stop camera
socket.emit('resumeProducer', { meetingId, producerId }, ack => {...});  // unmute / resume
socket.emit('closeProducer', { meetingId, producerId }, ack => {...});   // fully stop a track
socket.emit('restartIce', { meetingId, transportId }, ack => {
  if (ack.success) transport.restartIce({ iceParameters: ack.data });
});
```

**7. Leave**

```js
socket.emit('leaveRoom', { meetingId }, () => socket.close());
```

If the socket just drops (network loss, tab close) without an explicit `leaveRoom`, the
server gives it a `DISCONNECT_GRACE_PERIOD_MS` (10s default) reconnect window before
finalizing the leave and broadcasting `userLeft` — reconnect with the same `joinRoom` call
and the same `userId` within that window to resume seamlessly (your producers/consumers do
*not* survive — you'll need to re-produce, but your participant record and role do).

### 2.4 Screen share

```js
socket.emit('startScreenShare', { meetingId }, (ack) => {
  if (!ack.success) return; // someone else is already presenting, or screenShare is disabled
  // now produce a video track with appData: { source: 'screen' }
});
```

`startScreenShare` reserves the single presenter slot (only one active presentation at a
time, enforced server-side) before you actually produce; the `screenShareStarted`/
`screenShareStopped` broadcasts fire once the track is actually produced/closed
(`stopScreenShare` closes any of your own screen-share producers and releases the slot,
even if you reserved it and never actually produced).

### 2.5 Group-meeting-only events (`/meetings` namespace)

All ack-based unless noted as a broadcast.

| Event | Payload | Notes |
|---|---|---|
| `raiseHand` | `{ meetingId }` | broadcasts `handRaised { peerId }` |
| `lowerHand` | `{ meetingId }` | broadcasts `handLowered { peerId }` |
| `reaction` | `{ meetingId, emoji }` | must be one of `👍 👎 ❤️ 👏 🎉 😂 😮 🙌 🤔 💯`; rate-limited to 5/2s per user; broadcasts `reaction { peerId, emoji, at }` |
| `chatMessage` | `{ meetingId, text }` | broadcasts `chatMessage { id, meetingId, senderId, senderName, type: 'text', text, sentAt }`; rejected if `meeting.chatEnabled` is false |
| `mute` | `{ meetingId, targetUserId }` | host/moderator only; **forces** the target's mic off (server pauses their producer directly) and emits `forceMuted { by }` to them + `audioMuted { peerId, forced: true }` to the room |
| `requestUnmute` | `{ meetingId, targetUserId }` | host/moderator only; only *requests* — emits `unmuteRequested { by }` to the target, who must call `resumeProducer` themselves. (Mute can be forced; unmute never can — nobody should be able to turn your mic on without your action.) |
| `kick` | `{ meetingId, targetUserId }` | host/moderator only; broadcasts `participantRemoved { peerId, by }`, then disconnects them |
| `promoteModerator` / `demoteModerator` | `{ meetingId, targetUserId }` | host only; broadcasts `participantRoleChanged { peerId, role }` |
| `lockMeeting` / `unlockMeeting` | `{ meetingId }` | host/moderator only; broadcasts `meetingLocked`/`meetingUnlocked { meetingId }` |
| `disableFeature` | `{ meetingId, feature: 'chat'\|'reactions'\|'screenShare', enabled }` | host/moderator only; broadcasts `meetingStateUpdated` (full state) |
| `endMeeting` | `{ meetingId }` | **host only** — ends the meeting for everyone, broadcasts `meetingEnded { meetingId, reason }` |
| `admitWaitingParticipant` | `{ meetingId, targetUserId }` | host/moderator only; completes the waiting participant's join server-side and emits `admitted` (the full join result, see §2.3 step 1) directly to them |
| `rejectWaitingParticipant` | `{ meetingId, targetUserId }` | host/moderator only; emits `waitingRoomRejected` to them, then disconnects |

Permission checks are enforced server-side against the **caller's live role in the
meeting** (resolved from `hostId` + promotions tracked in memory) — a non-host calling
`mute` gets back `{ success: false, error: 'Missing permission: mute_others' }`, not a
silent no-op. Never trust a client-supplied role for anything; call-service doesn't either.

### 2.6 Other broadcasts you should listen for

| Event | Payload | When |
|---|---|---|
| `userJoined` | participant state | someone else joins after you |
| `userLeft` | `{ peerId }` | someone leaves (explicit or after the disconnect grace period) |
| `videoEnabled`/`videoDisabled` | `{ peerId }` | camera producer resumed/paused |
| `audioMuted`/`audioUnmuted` | `{ peerId, forced }` | mic producer paused/resumed (`forced: true` only when a host muted them) |
| `producerClosed` | `{ producerId }` | a producer you were consuming closed — tear down the matching consumer/UI tile |
| `activeSpeakerChanged` | `{ peerId }` | `peerId` is `null` during silence; driven by mediasoup's `AudioLevelObserver` |
| `meetingStateUpdated` | full meeting state | any host-control change (lock, feature toggles) |
| `heartbeatAck` | `{ at }` | reply to a client `heartbeat` emit — use to detect a signaling-only stall (media can die silently even while this channel looks fine) |

---

## 3. Environment checklist before wiring this up against a real deployment

From `.env.example` — the vars that will make the service refuse to boot or silently
misbehave if left at their placeholder defaults: `SERVICE_CREDENTIALS` (one
`apiKey:secretKey` pair per integrating service — the service throws at startup if this is
unset or empty; must match the credentials your backend/clients send), `MEDIASOUP_ANNOUNCED_IP`
(the public IP media should be sent to — wrong value here is the single most common
"signaling works, no audio/video" symptom), `TURN_HOST`. See the README's "coturn" section
for how `TURN_SECRET` ties into the `iceServers` your clients receive automatically at join
— you never configure ICE servers by hand on the client.

## 4. What isn't proven yet

Per the README: the actual RTP/DTLS media path has only been exercised at the signaling
level (10 simulated Socket.IO clients, no real browser/WebRTC stack in this environment).
Before wiring a production frontend against this, do one real two-browser call and confirm
audio/video actually flows — the signaling contract above is verified, the media path is
not.

## 5. Multi-instance deployment

Everything in §1–§4 above describes the single-instance contract, which is unchanged.
This section only applies once you run more than one call-service instance behind a load
balancer with `REDIS_URL` set on every instance (see `.env.example`'s "Redis /
multi-instance" section and `docker-compose.yml`'s `call-service`/`call-service-b`/`redis`
services for a runnable local example, `--profile scaling`).

**What's implemented:** each meeting's mediasoup Router still lives on exactly one
instance (the one whose REST call created it) — there is no cross-instance media routing
yet (that's `router.pipeToRouter`, tracked as a separate follow-up in the README). What
multi-instance mode adds is making that single-instance meeting reachable correctly no
matter which instance a request/connection happens to land on:

- **Socket.IO broadcasts fan out across instances** (Redis adapter) — `emitToMeeting`/
  `emitToSocket`/etc. reach a participant regardless of which instance their socket is on.
- **REST calls are transparently forwarded** to the meeting's actual owner. You can send
  `POST /meetings/:id/kick` (or any other `:id`-scoped call under `/meetings`, `/calls`) to
  *any* instance behind your load balancer — if it isn't the owner, it forwards the request
  and streams back the owner's response. You don't need your own routing logic for REST.
- **Socket connections are NOT forwarded** — a live WebRTC signaling session can't be
  proxied to another process. This is why `instanceUrl` exists (§1): after `POST /calls` or
  `POST /meetings`, open your Socket.IO connection against `instanceUrl`, not your load
  balancer's default routing.
- **Defense in depth**: if a socket connects to the wrong instance anyway (stale client
  cache, a load balancer that isn't meeting-aware), `joinRoom`'s ack response is:
  ```ts
  { success: false, error: 'WRONG_INSTANCE', data: { redirectUrl: string } }
  ```
  Reconnect your Socket.IO client to `redirectUrl` and retry `joinRoom`.

**Not yet implemented** (tracked as follow-up phases, see README): cross-instance media
routing for a single meeting that outgrows one instance's local worker capacity (room
sharding via `pipeToRouter`), and the recording pipeline. Neither blocks running multiple
instances today — they only matter once one meeting's participant count needs to spill
across instances, or you want server-side recording.
