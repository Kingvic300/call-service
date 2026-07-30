export interface WsAck<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Every request/response socket handler (joinRoom, produce, consume, ...)
 * returns this shape via the client's ack callback instead of throwing,
 * since Nest's default WsException handling doesn't feed back into
 * ack-style callbacks — this keeps error handling predictable for clients.
 */
export async function respond<T>(fn: () => Promise<T> | T): Promise<WsAck<T>> {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
