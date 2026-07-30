import type { Page } from '@playwright/test';
import { browserAppUrl, config } from './config.js';
import type { TestUser } from '../users/generate-users.js';

// Deliberately loosely typed here: this file (compiled by tsc/tsx under
// Node's DOM+Node lib) and browser-app/client.ts (compiled separately by
// esbuild into the actual browser bundle) are two independent TS programs —
// there's no real shared `Window` type to merge, so `page.evaluate` closures
// below just treat `window` as `any` rather than fighting global declaration
// merging across the two.

/**
 * Node-side handle for one simulated participant. Wraps a Playwright Page
 * running browser-app's TestCallClient (real mediasoup-client + real
 * getUserMedia via Chromium's fake-device flags) behind a small RPC bridge —
 * `call()` invokes any TestCallClient method by name inside the page.
 */
export class PeerHandle {
  constructor(
    readonly page: Page,
    readonly user: TestUser,
  ) {}

  static async create(page: Page, user: TestUser): Promise<PeerHandle> {
    await page.goto(browserAppUrl);
    await page.waitForFunction(() => Boolean((window as any).CallClientBundle));
    await page.evaluate(() => {
      (window as any).__client = new (window as any).CallClientBundle.TestCallClient();
    });
    return new PeerHandle(page, user);
  }

  /** Generic bridge — calls any TestCallClient method by name inside the browser page. */
  async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.page.evaluate(
      ({ method, args }) => {
        const client = (window as any).__client;
        if (!client) throw new Error('client not initialized');
        const fn = client[method];
        if (typeof fn !== 'function') throw new Error(`Unknown client method: ${method}`);
        return fn.apply(client, args);
      },
      { method, args },
    ) as Promise<T>;
  }

  async connect(namespace: '/calls' | '/meetings'): Promise<void> {
    await this.call('connect', config.callServiceWsUrl, namespace, this.user.token);
  }

  async joinRoom(meetingId: string) {
    return this.call<{ success: boolean; data?: { waiting: boolean }; error?: string }>('joinRoom', meetingId);
  }

  async getEvents<T = unknown>(): Promise<Array<{ event: string; payload: T; at: number }>> {
    return this.call('getEvents');
  }

  async eventsOfType<T = unknown>(event: string): Promise<Array<{ event: string; payload: T; at: number }>> {
    return this.call('eventsOfType', event);
  }

  async connectionState(kind: 'send' | 'recv'): Promise<string> {
    return this.call('connectionState', kind);
  }

  async close(): Promise<void> {
    await this.call('disconnect').catch(() => {});
    await this.page.context().close().catch(() => {});
  }
}
