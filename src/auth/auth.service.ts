import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { CredentialsService } from '../credentials/credentials.service';
import { AuthenticatedUser } from './interfaces/authenticated-user.interface';

/**
 * Every integrating service (NTeam-Backend, or any future caller) gets its
 * own (apiKey, secretKey) pair — call-service has no account relationship
 * with end users of its own, so unlike a typical app it never verifies an
 * end-user's identity directly. Instead it authenticates the *service*
 * cryptographically, the same trust model Twilio/Daily/Zoom-style video
 * platform APIs use, and trusts whatever userId/displayName/avatarUrl that
 * already-authenticated service asserts for a given connection or request.
 *
 * Two credential sources, checked in order:
 *  1. SERVICE_CREDENTIALS (static, env-configured) — the bootstrap path,
 *     works with no DB dependency; what local dev/testing use.
 *  2. CredentialsService (DB-backed) — lets a new integration be added, or
 *     an existing one rotated/revoked, without redeploying call-service.
 *     A no-op fallback (always misses) when MONGO_URI isn't configured.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly services: Map<string, string>;

  constructor(
    private readonly config: ConfigService,
    private readonly credentials: CredentialsService,
  ) {
    this.services = parseServiceCredentials(
      this.config.getOrThrow<string>('SERVICE_CREDENTIALS'),
    );

    if (this.services.size === 0) {
      throw new Error(
        'SERVICE_CREDENTIALS must contain at least one apiKey:secretKey pair',
      );
    }
  }

  /**
   * Verifies the calling service's (apiKey, secretKey) pair, then resolves
   * the end-user identity that service asserted for this connection. Never
   * accepts client-supplied role/permission claims — role is always
   * resolved server-side from meeting.hostId / promotions tracked by
   * ParticipantService.
   */
  async verifyServiceUser(
    apiKey: string | undefined,
    secretKey: string | undefined,
    userId: string | undefined,
    displayName?: string,
    avatarUrl?: string,
  ): Promise<AuthenticatedUser> {
    if (!(await this.verifyApiKey(apiKey, secretKey))) {
      throw new UnauthorizedException('Invalid apiKey/secretKey');
    }
    if (!userId) {
      throw new UnauthorizedException('Missing userId');
    }

    return {
      id: userId,
      displayName: displayName || userId,
      avatarUrl,
    };
  }

  /** (apiKey, secretKey) check — used directly by REST's ApiKeyGuard, and by verifyServiceUser above for sockets. */
  async verifyApiKey(
    apiKey: string | undefined,
    secretKey: string | undefined,
  ): Promise<boolean> {
    if (!apiKey || !secretKey) return false;

    const expectedSecret = this.services.get(apiKey);
    if (expectedSecret) {
      if (timingSafeEqualStrings(secretKey, expectedSecret)) return true;
      this.logger.warn(
        `Rejected request with invalid apiKey/secretKey (apiKey=${apiKey})`,
      );
      return false;
    }

    // Not a statically-configured service — check the DB-backed registry
    // before giving up (a no-op miss if MONGO_URI isn't configured).
    if (await this.credentials.verify(apiKey, secretKey)) return true;

    this.logger.warn(
      `Rejected request with invalid apiKey/secretKey (apiKey=${apiKey})`,
    );
    return false;
  }
}

function parseServiceCredentials(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const [apiKey, secretKey] = pair.split(':').map((s) => s.trim());
    if (apiKey && secretKey) map.set(apiKey, secretKey);
  }
  return map;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers to avoid a cheap
    // length-based timing oracle.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
