import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SlidingWindowLimiter } from '../utils/sliding-window-limiter';

/**
 * Shared connection-time auth + rate limiting for every signaling namespace
 * (spec: "Rate-limit socket connections", "Prevent unauthorized room joins").
 */
@Injectable()
export class ConnectionGuardService {
  private readonly logger = new Logger(ConnectionGuardService.name);
  private readonly connectionLimiter: SlidingWindowLimiter;
  private readonly eventLimiter: SlidingWindowLimiter;

  constructor(
    private readonly authService: AuthService,
    config: ConfigService,
  ) {
    this.connectionLimiter = new SlidingWindowLimiter(
      config.get<number>('CONNECTION_RATE_LIMIT_PER_MINUTE', 60),
      60_000,
    );
    this.eventLimiter = new SlidingWindowLimiter(
      config.get<number>('WS_RATE_LIMIT_POINTS', 30),
      config.get<number>('WS_RATE_LIMIT_DURATION_MS', 1000),
    );
  }

  /** Returns the authenticated user, or throws + the caller must disconnect the socket. */
  authenticate(client: Socket): AuthenticatedUser {
    const ip = client.handshake.address;
    if (!this.connectionLimiter.consume(ip)) {
      throw new UnauthorizedException('Too many connection attempts, slow down');
    }

    const token = this.extractToken(client);
    if (!token) throw new UnauthorizedException('Missing auth token');

    return this.authService.verifyUserToken(token);
  }

  /** Per-socket event flood guard, called at the top of every @SubscribeMessage handler. */
  checkEventRate(client: Socket): boolean {
    return this.eventLimiter.consume(client.id);
  }

  /**
   * Must be called from every gateway's handleDisconnect. socket.io never
   * reuses a socket id, so without this the eventLimiter's per-socket hit
   * map only ever grows — one abandoned entry per connection this server
   * has ever seen since boot, for as long as the process stays up.
   */
  releaseConnection(client: Socket): void {
    this.eventLimiter.reset(client.id);
  }

  private extractToken(client: Socket): string | undefined {
    const authToken = client.handshake.auth?.token as string | undefined;
    if (authToken) return authToken;

    const header = client.handshake.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);

    return undefined;
  }
}
