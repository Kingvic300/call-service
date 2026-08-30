import {
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
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
export class ConnectionGuardService implements OnModuleDestroy {
  private readonly logger = new Logger(ConnectionGuardService.name);
  private readonly connectionLimiter: SlidingWindowLimiter;
  private readonly eventLimiter: SlidingWindowLimiter;
  private readonly sweepInterval: NodeJS.Timeout;

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

    // Safety net: connectionLimiter is keyed by user id (or IP pre-auth), so
    // there's no single disconnect hook that covers every key — periodically
    // drop fully-expired entries so the map doesn't grow by one entry per
    // distinct caller ever seen, forever, for the life of the process.
    this.sweepInterval = setInterval(() => {
      this.connectionLimiter.sweepExpired();
    }, 5 * 60_000);
    this.sweepInterval.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepInterval);
  }

  /** Returns the authenticated user, or throws + the caller must disconnect the socket. */
  async authenticate(client: Socket): Promise<AuthenticatedUser> {
    const ip = client.handshake.address;
    const { apiKey, secretKey, userId, displayName, avatarUrl } =
      this.extractCredentials(client);

    let user: AuthenticatedUser;
    try {
      user = await this.authService.verifyServiceUser(
        apiKey,
        secretKey,
        userId,
        displayName,
        avatarUrl,
      );
    } catch (err) {
      // No verified identity to key by yet — fall back to the IP limiter so
      // a flood of garbage/missing tokens is still throttled.
      if (!this.connectionLimiter.consume(ip)) {
        throw new UnauthorizedException(
          'Too many connection attempts, slow down',
        );
      }
      throw err;
    }

    // Keyed by the authenticated user rather than the socket's IP from here
    // on: NTeam-Backend proxies every 1:1 call's upstream connection through
    // its own single server IP (one new socket per call — see
    // CallServiceProxyService.connectUpstream), so an IP-keyed limit here
    // throttled the whole platform's call volume instead of any one user,
    // tripping "Too many connection attempts" under ordinary traffic and
    // disconnecting the proxy mid-joinRoom (reason: "io server disconnect").
    if (!this.connectionLimiter.consume(user.id)) {
      throw new UnauthorizedException(
        'Too many connection attempts, slow down',
      );
    }

    return user;
  }

  /** Per-socket event flood guard, called at the top of every @SubscribeMessage handler. */
  checkEventRate(client: Socket): boolean {
    return this.eventLimiter.consume(client.id);
  }

  /**
   * Must be called from every gateway's handleDisconnect. socket.io never
   * reuses a socket id, so without this the eventLimiter's per-socket hit
   * map only ever grows — one abandoned entry per connection this server
   * has ever seen since boot, for as long as the process stays up. Also
   * clears the connectionLimiter's entry for this user, which is keyed by
   * user id (not socket id) and otherwise only shrinks to an empty array
   * rather than being removed — the periodic sweep in the constructor is
   * the backstop for callers that never reach a disconnect at all.
   */
  releaseConnection(client: Socket): void {
    this.eventLimiter.reset(client.id);
    const user = client.data?.user as AuthenticatedUser | undefined;
    if (user?.id) {
      this.connectionLimiter.reset(user.id);
    }
  }

  private extractCredentials(client: Socket): {
    apiKey?: string;
    secretKey?: string;
    userId?: string;
    displayName?: string;
    avatarUrl?: string;
  } {
    const auth = (client.handshake.auth ?? {}) as Record<string, unknown>;
    const asString = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return {
      apiKey: asString(auth.apiKey),
      secretKey: asString(auth.secretKey),
      userId: asString(auth.userId),
      displayName: asString(auth.displayName),
      avatarUrl: asString(auth.avatarUrl),
    };
  }
}
