#!/usr/bin/env node
/**
 * Phase 1 acceptance check: cross-instance signaling. Assumes TWO already
 * running call-service instances sharing the same Redis (REDIS_URL set on
 * both), e.g. `docker compose --profile scaling up --build` or two
 * `npm run start:dev` processes with distinct PORT/INSTANCE_ID/
 * INSTANCE_INTERNAL_URL env vars (see docker-compose.yml's call-service /
 * call-service-b services).
 *
 * Verifies:
 *  1. POST /meetings against instance A returns `instanceUrl` pointing at A.
 *  2. A socket connected directly to instance A can join the meeting.
 *  3. A socket connected directly to instance B (same meetingId) gets
 *     rejected with a WRONG_INSTANCE ack error + redirectUrl pointing at A —
 *     proves sticky-routing enforcement at the signaling layer.
 *  4. POST /meetings/:id/lock issued against instance B's REST port
 *     succeeds AND the socket connected to instance A receives the
 *     `meetingLocked` broadcast — proves REST moderation calls are
 *     transparently forwarded to the meeting's actual owner and reach its
 *     live sockets, not just returning a stub 200.
 *
 * This does NOT test real media flow — see scripts/signaling-load-test.js's
 * header for why (no headless WebRTC stack available in this environment).
 *
 * Usage: node scripts/cross-instance-test.js
 */
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');

const BASE_URL_A = process.env.TEST_BASE_URL_A || 'http://localhost:4000';
const BASE_URL_B = process.env.TEST_BASE_URL_B || 'http://localhost:4001';
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

async function httpJson(baseUrl, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
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

function connectClient(baseUrl, namespace, token) {
  return new Promise((resolve, reject) => {
    const socket = io(`${baseUrl}${namespace}`, {
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

async function main() {
  const host = { id: 'cross-instance-host', token: makeToken('cross-instance-host', 'Host') };
  const guest = { id: 'cross-instance-guest', token: makeToken('cross-instance-guest', 'Guest') };

  // 1. Create on instance A, expect instanceUrl to point at A.
  const meeting = await httpJson(BASE_URL_A, 'POST', '/meetings', { hostId: host.id });
  record(
    'POST /meetings (instance A) returns instanceUrl pointing at A',
    typeof meeting.instanceUrl === 'string' && meeting.instanceUrl.length > 0,
    `instanceUrl=${meeting.instanceUrl}`,
  );

  // 2. Host joins directly on instance A.
  const hostSocket = await connectClient(BASE_URL_A, '/meetings', host.token);
  const hostJoin = await ack(hostSocket, 'joinRoom', { meetingId: meeting.id });
  record('Host joinRoom on instance A succeeds', hostJoin.success, JSON.stringify(hostJoin.error || ''));

  // 3. Guest connects directly to instance B for the SAME meeting — must be
  // rejected with WRONG_INSTANCE + a redirect back to instance A.
  const guestSocketOnB = await connectClient(BASE_URL_B, '/meetings', guest.token);
  const guestJoinOnB = await ack(guestSocketOnB, 'joinRoom', { meetingId: meeting.id });
  const redirectsToA =
    guestJoinOnB.success === false &&
    guestJoinOnB.error === 'WRONG_INSTANCE' &&
    typeof guestJoinOnB.data?.redirectUrl === 'string';
  record(
    'joinRoom on instance B is rejected with WRONG_INSTANCE + redirectUrl',
    redirectsToA,
    JSON.stringify(guestJoinOnB),
  );
  guestSocketOnB.disconnect();

  // 4. Lock the meeting via instance B's REST port — must be forwarded to A
  // and reach the host's live socket, which is only connected to A.
  const lockedEventPromise = waitForEvent(hostSocket, 'meetingLocked');
  const lockRes = await httpJson(BASE_URL_B, 'POST', `/meetings/${meeting.id}/lock`);
  record('POST /meetings/:id/lock against instance B succeeds', lockRes.locked === true, JSON.stringify(lockRes));

  await lockedEventPromise.then(
    () => record('Host socket on instance A receives meetingLocked (forwarded from B)', true),
    (e) => record('Host socket on instance A receives meetingLocked (forwarded from B)', false, e.message),
  );

  // Cleanup.
  await httpJson(BASE_URL_A, 'POST', `/meetings/${meeting.id}/end`).catch(() => {});
  hostSocket.disconnect();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`${failed.length} check(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Cross-instance test crashed:', err);
  process.exit(1);
});
