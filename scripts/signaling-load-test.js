#!/usr/bin/env node
/**
 * Simulates 10 client accounts against a running call-service instance to
 * exercise the signaling layer: auth, join/leave, transport creation,
 * connectTransport (fake DTLS params — exercises the code path, not a real
 * handshake), audio produce/consume with a hand-built minimal RTP fixture,
 * chat, reactions, raise hand, host mute/kick, lock/unlock, and disconnect
 * cleanup — across both a 1:1 /calls room and a 10-person /meetings room.
 *
 * This does NOT test real media flow (RTP/DTLS/ICE) — that needs a real
 * mediasoup-client in a browser, which can't run headless here. See the
 * README "What was and wasn't tested" section.
 *
 * Usage: node scripts/signaling-load-test.js
 * Requires the server running locally (npm run start:dev) with a known
 * JWT_SECRET, matched via the JWT_SECRET env var to this script.
 */
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:4000';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-to-a-long-random-secret';
const API_KEY = (process.env.INTERNAL_API_KEYS || 'change-me-internal-key').split(',')[0].trim();

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const icon = ok ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${name}${detail ? ' — ' + detail : ''}`);
}

function makeToken(userId, name) {
  return jwt.sign({ sub: userId, name }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

async function httpJson(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function connectClient(namespace, token) {
  return new Promise((resolve, reject) => {
    const socket = io(`${BASE_URL}${namespace}`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    const timer = setTimeout(() => reject(new Error('connect timeout')), 6000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function ack(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), timeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function waitForEvent(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function fakeDtlsParameters() {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(':');
  return { role: 'client', fingerprints: [{ algorithm: 'sha-256', value: hex }] };
}

function fakeOpusRtpParameters(ssrc) {
  return {
    codecs: [
      {
        mimeType: 'audio/opus',
        payloadType: 100,
        clockRate: 48000,
        channels: 2,
        parameters: { useinbandfec: 1 },
        rtcpFeedback: [],
      },
    ],
    headerExtensions: [],
    encodings: [{ ssrc }],
    rtcp: { cname: `test-cname-${ssrc}` },
  };
}

async function testOneToOneCall(users) {
  const [alice, bob] = users;
  const call = await httpJson('POST', '/calls', { callerId: alice.id });
  record('POST /calls creates a 1:1 call', !!call.id, `id=${call.id}`);

  const aliceSocket = await connectClient('/calls', alice.token);
  const bobSocket = await connectClient('/calls', bob.token);
  record('Both users connect to /calls with valid JWT', true);

  const aliceJoin = await ack(aliceSocket, 'joinRoom', { meetingId: call.id });
  record('Alice joinRoom succeeds', aliceJoin.success, JSON.stringify(aliceJoin.error || ''));

  const bobJoinedPromise = waitForEvent(aliceSocket, 'userJoined');
  const bobJoin = await ack(bobSocket, 'joinRoom', { meetingId: call.id });
  record('Bob joinRoom succeeds', bobJoin.success, JSON.stringify(bobJoin.error || ''));
  await bobJoinedPromise.then(
    () => record('Alice receives userJoined for Bob', true),
    (e) => record('Alice receives userJoined for Bob', false, e.message),
  );

  const sendTransport = await ack(aliceSocket, 'createTransport', { meetingId: call.id, direction: 'send' });
  record('Alice createTransport(send) succeeds', sendTransport.success, JSON.stringify(sendTransport.error || ''));

  if (sendTransport.success) {
    const connectRes = await ack(aliceSocket, 'connectTransport', {
      meetingId: call.id,
      transportId: sendTransport.data.id,
      dtlsParameters: fakeDtlsParameters(),
    });
    record('Alice connectTransport succeeds (fake DTLS, API path only)', connectRes.success, JSON.stringify(connectRes.error || ''));

    const produceRes = await ack(aliceSocket, 'produce', {
      meetingId: call.id,
      transportId: sendTransport.data.id,
      kind: 'audio',
      rtpParameters: fakeOpusRtpParameters(11111111),
      appData: { source: 'mic' },
    });
    record('Alice produce(audio) succeeds', produceRes.success, JSON.stringify(produceRes.error || ''));

    if (produceRes.success) {
      const bobRecvTransport = await ack(bobSocket, 'createTransport', { meetingId: call.id, direction: 'recv' });
      record('Bob createTransport(recv) succeeds', bobRecvTransport.success, JSON.stringify(bobRecvTransport.error || ''));

      if (bobRecvTransport.success) {
        const newProducerPromise = waitForEvent(bobSocket, 'newProducer').catch(() => null);
        const producerId = (await newProducerPromise)?.producerId || produceRes.data.id;

        const consumeRes = await ack(bobSocket, 'consume', {
          meetingId: call.id,
          transportId: bobRecvTransport.data.id,
          producerId,
          rtpCapabilities: aliceJoin.data.rtpCapabilities,
        });
        record('Bob consume(audio) succeeds', consumeRes.success, JSON.stringify(consumeRes.error || ''));
      }
    }
  }

  const restartRes = await ack(aliceSocket, 'restartIce', {
    meetingId: call.id,
    transportId: sendTransport.success ? sendTransport.data.id : 'missing',
  });
  record('restartIce returns a response (success or clean error)', typeof restartRes.success === 'boolean');

  aliceSocket.close();
  bobSocket.close();
  record('1:1 call sockets close cleanly', true);
}

async function testGroupMeeting(hostUser, otherUsers) {
  const meeting = await httpJson('POST', '/meetings', { hostId: hostUser.id, waitingRoomEnabled: false });
  record('POST /meetings creates a group meeting', !!meeting.id, `id=${meeting.id}`);

  const hostSocket = await connectClient('/meetings', hostUser.token);
  const hostJoin = await ack(hostSocket, 'joinRoom', { meetingId: meeting.id });
  record('Host joinRoom succeeds', hostJoin.success, JSON.stringify(hostJoin.error || ''));

  const guestSockets = [];
  for (const user of otherUsers) {
    const socket = await connectClient('/meetings', user.token);
    const join = await ack(socket, 'joinRoom', { meetingId: meeting.id });
    if (!join.success) record(`Participant ${user.id} joinRoom`, false, JSON.stringify(join.error));
    guestSockets.push({ user, socket });
  }
  record(`All ${otherUsers.length} additional participants joined`, guestSockets.length === otherUsers.length);

  // Chat
  const chatSeen = waitForEvent(hostSocket, 'chatMessage').catch(() => null);
  const chatRes = await ack(guestSockets[0].socket, 'chatMessage', { meetingId: meeting.id, text: 'hello from load test' });
  record('chatMessage accepted', chatRes.success, JSON.stringify(chatRes.error || ''));
  await chatSeen.then(
    (m) => record('Host receives broadcast chatMessage', !!m, m ? m.text : ''),
    () => record('Host receives broadcast chatMessage', false),
  );

  // Reaction
  const reactionRes = await ack(guestSockets[1].socket, 'reaction', { meetingId: meeting.id, emoji: '👍' });
  record('reaction accepted for allowed emoji', reactionRes.success, JSON.stringify(reactionRes.error || ''));
  const badReactionRes = await ack(guestSockets[1].socket, 'reaction', { meetingId: meeting.id, emoji: '💀' });
  record('reaction rejected for disallowed emoji', badReactionRes.success === false);

  // Raise hand
  const handRes = await ack(guestSockets[2].socket, 'raiseHand', { meetingId: meeting.id });
  record('raiseHand accepted', handRes.success, JSON.stringify(handRes.error || ''));

  // Host mute
  const muteRes = await ack(hostSocket, 'mute', { meetingId: meeting.id, targetUserId: guestSockets[3].user.id });
  record('Host mute(participant) accepted', muteRes.success, JSON.stringify(muteRes.error || ''));

  // Non-host attempting to mute someone else should be rejected
  const forbiddenMuteRes = await ack(guestSockets[4].socket, 'mute', { meetingId: meeting.id, targetUserId: guestSockets[5].user.id });
  record('Non-host mute is rejected (permission check works)', forbiddenMuteRes.success === false, JSON.stringify(forbiddenMuteRes.error || ''));

  // Lock / unlock
  const lockRes = await ack(hostSocket, 'lockMeeting', { meetingId: meeting.id });
  record('Host lockMeeting accepted', lockRes.success, JSON.stringify(lockRes.error || ''));
  const unlockRes = await ack(hostSocket, 'unlockMeeting', { meetingId: meeting.id });
  record('Host unlockMeeting accepted', unlockRes.success, JSON.stringify(unlockRes.error || ''));

  // Host kick
  const kickTarget = guestSockets[6];
  const kickedPromise = waitForEvent(kickTarget.socket, 'errorEvent').catch(() => null);
  const kickRes = await ack(hostSocket, 'kick', { meetingId: meeting.id, targetUserId: kickTarget.user.id });
  record('Host kick(participant) accepted', kickRes.success, JSON.stringify(kickRes.error || ''));
  await kickedPromise;

  // GET /participants/:meetingId reflects state
  const participants = await httpJson('GET', `/participants/${meeting.id}`);
  record(
    'GET /participants reflects post-kick roster',
    Array.isArray(participants) && !participants.find((p) => p.userId === kickTarget.user.id),
    `count=${Array.isArray(participants) ? participants.length : 'n/a'}`,
  );

  // Cleanup: everyone leaves, then host ends the meeting
  for (const { socket } of guestSockets) socket.close();
  const endRes = await ack(hostSocket, 'endMeeting', { meetingId: meeting.id });
  record('Host endMeeting accepted', endRes.success, JSON.stringify(endRes.error || ''));
  hostSocket.close();
}

async function testUnauthorizedRejected() {
  // The server's handleConnection is async-safe but the reject path still lets
  // the Engine.IO handshake complete before disconnecting — so the client-side
  // 'connect' event can fire a moment before the server kicks it. Wait for an
  // explicit disconnect/connect_error rather than trusting 'connect' alone.
  const socket = io(`${BASE_URL}/meetings`, {
    auth: { token: 'not-a-real-jwt' },
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
  });

  const rejected = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    socket.on('disconnect', () => {
      clearTimeout(timer);
      resolve(true);
    });
    socket.on('connect_error', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  record('Connection with invalid JWT is rejected', rejected, rejected ? '' : 'socket stayed connected for 3s');
  socket.close();
}

async function main() {
  const users = Array.from({ length: 10 }, (_, i) => ({
    id: `loadtest-user-${i + 1}`,
    token: makeToken(`loadtest-user-${i + 1}`, `Load Test User ${i + 1}`),
  }));

  console.log(`Running signaling load test against ${BASE_URL} with ${users.length} simulated accounts...\n`);

  try {
    await testOneToOneCall(users.slice(0, 2));
  } catch (e) {
    record('1:1 call test suite', false, e.message);
  }

  try {
    await testGroupMeeting(users[2], users.slice(3, 10));
  } catch (e) {
    record('Group meeting test suite', false, e.message);
  }

  try {
    await testUnauthorizedRejected();
  } catch (e) {
    record('Unauthorized rejection test', false, e.message);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('\nFailed checks:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Load test crashed:', err);
  process.exitCode = 1;
});
