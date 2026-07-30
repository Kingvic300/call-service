import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from '@playwright/test';
import { PeerHandle } from './peer.js';
import type { TestUser } from '../users/generate-users.js';
import { restClient, type MeetingState } from './rest-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedUsers: TestUser[] | null = null;

/** Loads users.json, generating it first if it doesn't exist yet. */
export function loadUsers(): TestUser[] {
  if (cachedUsers) return cachedUsers;
  const usersPath = path.join(__dirname, '..', 'users.json');
  if (!fs.existsSync(usersPath)) {
    throw new Error('users.json not found — run `npm run generate:users` first');
  }
  cachedUsers = JSON.parse(fs.readFileSync(usersPath, 'utf8')) as TestUser[];
  return cachedUsers;
}

export function userByRole(role: string): TestUser {
  const user = loadUsers().find((u) => u.role === role);
  if (!user) throw new Error(`No test user with role "${role}"`);
  return user;
}

/** Opens a real browser page for `user`, connects it to the given namespace. Each peer owns its own browser context. */
export async function openPeer(
  browser: Browser,
  user: TestUser,
  namespace: '/calls' | '/meetings',
): Promise<PeerHandle> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const peer = await PeerHandle.create(page, user);
  await peer.connect(namespace);
  return peer;
}

export async function closePeers(peers: PeerHandle[]): Promise<void> {
  await Promise.all(peers.map((p) => p.close()));
}

export interface MeetingRig {
  meeting: MeetingState;
  host: PeerHandle;
  peers: Record<string, PeerHandle>;
  all: PeerHandle[];
}

/**
 * Creates a group meeting, opens one real browser peer per role (host +
 * participantRoles), joins them all, and has each produce a mic track so
 * consume/media assertions have something real to check. Shared by most of
 * the /meetings scenarios to keep each spec file focused on its own
 * assertions instead of repeating this boilerplate.
 */
export async function setupMeeting(
  browser: Browser,
  hostRole: string,
  participantRoles: string[],
  opts: Partial<{ waitingRoomEnabled: boolean; chatEnabled: boolean; reactionsEnabled: boolean; screenShareEnabled: boolean }> = {},
  produceMic = true,
): Promise<MeetingRig> {
  const hostUser = userByRole(hostRole);
  const meeting = await restClient.createMeeting(hostUser.id, opts);

  const host = await openPeer(browser, hostUser, '/meetings');
  const hostJoin = await host.joinRoom(meeting.id);
  if (!hostJoin.success) throw new Error(`Host join failed: ${hostJoin.error}`);
  if (produceMic) await host.call('produceMic');

  const peers: Record<string, PeerHandle> = {};
  for (const role of participantRoles) {
    const user = userByRole(role);
    const peer = await openPeer(browser, user, '/meetings');
    const join = await peer.joinRoom(meeting.id);
    if (!join.success) throw new Error(`${role} join failed: ${join.error}`);
    if (produceMic) await peer.call('produceMic');
    peers[role] = peer;
  }

  return { meeting, host, peers, all: [host, ...Object.values(peers)] };
}

/** Generic condition poller for assertions with no dedicated Playwright matcher. */
export async function waitUntil(fn: () => Promise<boolean> | boolean, timeoutMs = 8000, intervalMs = 150): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
