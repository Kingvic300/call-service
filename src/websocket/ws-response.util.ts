import { WrongInstanceError } from './wrong-instance.error';

export interface WsAck<T = unknown> {
  success: boolean;
  data?: T | { redirectUrl: string };
  error?: string;
}

/**
 * Every request/response socket handler (joinRoom, produce, consume, ...)
 * returns this shape via the client's ack callback instead of throwing,
 * since Nest's default WsException handling doesn't feed back into
 * ack-style callbacks — this keeps error handling predictable for clients.
 *
 * WrongInstanceError gets a distinct error code + redirectUrl payload
 * instead of the generic message string, since the client needs to act on
 * it (reconnect its socket elsewhere) rather than just display it.
 */
export async function respond<T>(fn: () => Promise<T> | T): Promise<WsAck<T>> {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (err) {
    if (err instanceof WrongInstanceError) {
      return { success: false, error: err.message, data: { redirectUrl: err.redirectUrl } };
    }
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
